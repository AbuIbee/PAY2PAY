import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { financialAccount, relationship, relationshipFinancialAccount, relationshipParticipant } from "@/db/schema";
import { ConflictError } from "@/lib/errors";
import { acquireAdvisoryLockBarrier } from "../../../test/postgres/lockBarrier";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { createIsolatedDb, warmUp } from "../../../test/postgres/testDb";
import { DrizzleRelationshipFinancialAccountRepository } from "./drizzleRelationshipFinancialAccountRepository";

const DATABASE_URL = process.env.DATABASE_URL!;

/**
 * R03 (DB integrity & concurrency hardening) — real-Postgres proof for
 * `DrizzleRelationshipFinancialAccountRepository.replaceAssignmentAtomically`. Tested directly at
 * the repository layer (not through `RelationshipFinancialAccountService`) — the property under test
 * (supersede-old + insert-new atomicity, and serialization of concurrent replacements for the same
 * slot) lives entirely inside this one repository method; the service's authorization/MFA/audit
 * layers are already covered by the existing in-memory unit suite
 * (relationshipFinancialAccountService.test.ts) and are orthogonal to this concurrency property.
 */
describe("R03: DrizzleRelationshipFinancialAccountRepository.replaceAssignmentAtomically (real Postgres)", () => {
  const repo = new DrizzleRelationshipFinancialAccountRepository();
  let userId: string;
  let profileId: string;

  beforeAll(async () => {
    const seeded = await seedPersonalUser("r03");
    userId = seeded.userId;
    profileId = seeded.profileId;
  });

  async function seedRelationship(): Promise<{ relationshipId: string; participantId: string }> {
    const db = getDb();
    const [rel] = await db.insert(relationship).values({ initiatorUserId: userId }).returning({ id: relationship.id });
    if (!rel) throw new Error("relationship insert returned no row");
    const [participant] = await db
      .insert(relationshipParticipant)
      .values({
        relationshipId: rel.id,
        individualProfileId: profileId,
        role: "debtor",
        status: "active",
        representedByUserId: userId,
      })
      .returning({ id: relationshipParticipant.id });
    if (!participant) throw new Error("relationship_participant insert returned no row");
    return { relationshipId: rel.id, participantId: participant.id };
  }

  async function seedFinancialAccount(providerRef: string): Promise<string> {
    const db = getDb();
    const [account] = await db
      .insert(financialAccount)
      .values({
        individualProfileId: profileId,
        organizationId: null,
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: providerRef,
        maskedLast4: "1234",
        institutionDisplayName: "Test Bank",
        status: "verified",
        addedByUserId: userId,
      })
      .returning({ id: financialAccount.id });
    if (!account) throw new Error("financial_account insert returned no row");
    return account.id;
  }

  async function activeAssignments(relationshipId: string) {
    const db = getDb();
    return db
      .select()
      .from(relationshipFinancialAccount)
      .where(eq(relationshipFinancialAccount.relationshipId, relationshipId));
  }

  it("R03-A: a successful replacement atomically supersedes the old assignment and creates exactly one new active assignment", async () => {
    const { relationshipId, participantId } = await seedRelationship();
    const accountA = await seedFinancialAccount(`r03a-${randomUUID()}`);
    const accountB = await seedFinancialAccount(`r03a-${randomUUID()}`);

    const first = await repo.replaceAssignmentAtomically({
      relationshipId,
      relationshipParticipantId: participantId,
      financialAccountId: accountA,
      usage: "funding",
      selectedByUserId: userId,
      expectedExistingId: null,
    });
    expect(first.status).toBe("active");

    const second = await repo.replaceAssignmentAtomically({
      relationshipId,
      relationshipParticipantId: participantId,
      financialAccountId: accountB,
      usage: "funding",
      selectedByUserId: userId,
      expectedExistingId: first.id,
    });
    expect(second.status).toBe("active");
    expect(second.id).not.toBe(first.id);

    const rows = await activeAssignments(relationshipId);
    const activeRows = rows.filter((r) => r.status === "active");
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.id).toBe(second.id);

    const supersededRow = rows.find((r) => r.id === first.id);
    expect(supersededRow?.status).toBe("superseded");
    expect(supersededRow?.supersededBy).toBe(second.id);
  });

  it("R03-B: a failed replacement (FK violation forces the insert to fail after the transaction has begun) rolls back entirely — the old assignment remains active", async () => {
    const { relationshipId, participantId } = await seedRelationship();
    const accountA = await seedFinancialAccount(`r03b-${randomUUID()}`);

    const original = await repo.replaceAssignmentAtomically({
      relationshipId,
      relationshipParticipantId: participantId,
      financialAccountId: accountA,
      usage: "payout",
      selectedByUserId: userId,
      expectedExistingId: null,
    });

    // A non-existent financial_account_id violates relationship_financial_account's real FK
    // constraint — the UPDATE (supersede) has already been issued inside this transaction by the
    // time the INSERT hits this violation, so this proves the whole transaction rolls back, not just
    // that the promise rejects.
    await expect(
      repo.replaceAssignmentAtomically({
        relationshipId,
        relationshipParticipantId: participantId,
        financialAccountId: randomUUID(),
        usage: "payout",
        selectedByUserId: userId,
        expectedExistingId: original.id,
      }),
    ).rejects.toThrow();

    const rows = await activeAssignments(relationshipId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(original.id);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.supersededBy).toBeNull();
  });

  it("R03-C: two replacements on genuinely distinct connections actually contend for the real advisory lock — exactly one wins, never zero/two active rows, valid history", async () => {
    const { relationshipId, participantId } = await seedRelationship();
    const original = await seedFinancialAccount(`r03c-orig-${randomUUID()}`);
    const accountA = await seedFinancialAccount(`r03c-a-${randomUUID()}`);
    const accountB = await seedFinancialAccount(`r03c-b-${randomUUID()}`);

    const originalAssignment = await repo.replaceAssignmentAtomically({
      relationshipId,
      relationshipParticipantId: participantId,
      financialAccountId: original,
      usage: "funding",
      selectedByUserId: userId,
      expectedExistingId: null,
    });

    // Corrective pass (Codex finding C): repoA/repoB are backed by two GENUINELY SEPARATE Postgres
    // connections (not the shared, max:1 `getDb()` singleton `repo` above uses) — real, independent
    // backend processes on the server, capable of actually holding overlapping transactions. The
    // barrier below pre-acquires the EXACT SAME advisory lock key `replaceAssignmentAtomically` uses
    // for this (relationshipId, usage) slot, on a THIRD connection, so both real calls are forced to
    // queue behind it — `waitUntilContended()` then proves, via `pg_stat_activity`, that both real
    // backends are genuinely blocked on that lock before the barrier releases, rather than inferring
    // overlap from `Promise.all` timing alone.
    //
    // FINAL corrective pass: `warmUp()` forces isolatedA/isolatedB's lazy physical connections to
    // fully establish, and returns their real backend pids, BEFORE the timed race starts — see
    // testDb.ts's own doc comment for why this (not environmental flakiness) was the actual cause of
    // this test's earlier intermittent timeouts, and lockBarrier.ts's doc comment for why checking
    // these SPECIFIC pids is strictly stronger proof than "any other backend was blocked".
    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    const repoA = new DrizzleRelationshipFinancialAccountRepository(isolatedA.db);
    const repoB = new DrizzleRelationshipFinancialAccountRepository(isolatedB.db);

    try {
      const pidA = await warmUp(isolatedA.client);
      const pidB = await warmUp(isolatedB.client);
      const barrier = await acquireAdvisoryLockBarrier(DATABASE_URL, relationshipId, "funding");

      const promiseA = repoA.replaceAssignmentAtomically({
        relationshipId,
        relationshipParticipantId: participantId,
        financialAccountId: accountA,
        usage: "funding",
        selectedByUserId: userId,
        expectedExistingId: originalAssignment.id,
      });
      const promiseB = repoB.replaceAssignmentAtomically({
        relationshipId,
        relationshipParticipantId: participantId,
        financialAccountId: accountB,
        usage: "funding",
        selectedByUserId: userId,
        expectedExistingId: originalAssignment.id,
      });

      // Codex (nonblocking cleanup): protect the release with `finally` so a failed/timed-out
      // contention assertion can never leave the holder's lock/connection open for the rest of this
      // test file's run (every subsequent test in this file shares the same disposable database).
      try {
        // Deterministic proof of real overlap: BOTH A and B are genuinely blocked, server-side, on
        // the same advisory lock this barrier holds — not a timing assumption, and not "any other
        // backend" (these are the two exact, known-in-advance connections under test).
        await barrier.waitUntilContended({ expectPids: [pidA, pidB] });
      } finally {
        await barrier.release();
      }

      const results = await Promise.allSettled([promiseA, promiseB]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof repoA.replaceAssignmentAtomically>>> => r.status === "fulfilled",
      );
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

      const rows = await activeAssignments(relationshipId);
      const activeRows = rows.filter((r) => r.status === "active");
      expect(activeRows).toHaveLength(1); // never zero, never two — even under proven real contention.
      expect(activeRows[0]?.id).toBe(fulfilled[0]?.value.id);

      const originalRow = rows.find((r) => r.id === originalAssignment.id);
      expect(originalRow?.status).toBe("superseded");
      expect(originalRow?.supersededBy).toBe(fulfilled[0]?.value.id); // valid history chain, not orphaned.
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("R03-C (sanity check): without ever acquiring the lock, two truly concurrent connections would race — proves the lock is the thing preventing corruption, not test luck", async () => {
    // This test deliberately does NOT use the barrier — it fires two real, concurrent
    // replaceAssignmentAtomically calls on two separate connections with no artificial
    // synchronization at all, repeated several times to make a would-be race window likely to be
    // hit if the advisory lock were ever accidentally removed from the implementation. It is a
    // regression sanity net, not the primary concurrency proof (that's the barrier-based test above).
    for (let attempt = 0; attempt < 5; attempt++) {
      const { relationshipId, participantId } = await seedRelationship();
      const original = await seedFinancialAccount(`r03c-sanity-orig-${attempt}-${randomUUID()}`);
      const accountA = await seedFinancialAccount(`r03c-sanity-a-${attempt}-${randomUUID()}`);
      const accountB = await seedFinancialAccount(`r03c-sanity-b-${attempt}-${randomUUID()}`);
      const originalAssignment = await repo.replaceAssignmentAtomically({
        relationshipId,
        relationshipParticipantId: participantId,
        financialAccountId: original,
        usage: "funding",
        selectedByUserId: userId,
        expectedExistingId: null,
      });

      const isolatedA = createIsolatedDb(DATABASE_URL);
      const isolatedB = createIsolatedDb(DATABASE_URL);
      try {
        const repoA = new DrizzleRelationshipFinancialAccountRepository(isolatedA.db);
        const repoB = new DrizzleRelationshipFinancialAccountRepository(isolatedB.db);
        const results = await Promise.allSettled([
          repoA.replaceAssignmentAtomically({
            relationshipId,
            relationshipParticipantId: participantId,
            financialAccountId: accountA,
            usage: "funding",
            selectedByUserId: userId,
            expectedExistingId: originalAssignment.id,
          }),
          repoB.replaceAssignmentAtomically({
            relationshipId,
            relationshipParticipantId: participantId,
            financialAccountId: accountB,
            usage: "funding",
            selectedByUserId: userId,
            expectedExistingId: originalAssignment.id,
          }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const rows = await activeAssignments(relationshipId);
        expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
      } finally {
        await isolatedA.close();
        await isolatedB.close();
      }
    }
  });
});
