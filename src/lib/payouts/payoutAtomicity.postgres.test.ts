import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, auditEvent, ledgerJournalEntry, paymentAttempt, payoutAttempt } from "@/db/schema";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import type { AuditEventPayload } from "@/lib/audit/hash";
import { DrizzleAdminAuditReader } from "@/lib/admin/drizzleAdminAuditReader";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { DrizzleLedgerAccountRepository } from "@/lib/ledger/drizzleLedgerAccountRepository";
import { DrizzleLedgerJournalEntryRepository } from "@/lib/ledger/drizzleLedgerJournalEntryRepository";
import { LedgerService } from "@/lib/ledger/ledgerService";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { createIsolatedDb, warmUp } from "../../../test/postgres/testDb";
import { waitUntilPidBlockedOnLock } from "../../../test/postgres/lockBarrier";
import { DrizzleAtomicPayoutConfirmer, type AtomicPayoutConfirmerTestHooks } from "./atomicPayoutConfirmer";
import { DrizzleAtomicPayoutReturner } from "./atomicPayoutReturner";
import { DrizzlePayoutAttemptRepository } from "./drizzlePayoutAttemptRepository";
import type { PayoutAttemptRepository } from "./payoutAttemptRepository";
import { PayoutService } from "./payoutService";

const DATABASE_URL = process.env.DATABASE_URL!;

/**
 * Stage 4 — WP-01 (payout concurrency and local atomicity proof, real PostgreSQL). Mandatory
 * real-Postgres proof for FI-03/FI-05/FI-07/FI-09(local portion) on the payout lifecycle: no test of
 * any kind previously exercised `PayoutService.recordPayoutOwed`/`confirmPayout`/`returnPayout`
 * concurrently or under fault injection (see docs/remediation/ — the Stage 4 scope-lock corrections
 * this package closes). Mirrors `paymentWebhookRecovery.postgres.test.ts`'s established
 * two-genuinely-separate-connections / lock-barrier conventions throughout — never a
 * single-connection `Promise.all` presented as proof of database-level contention where a real lock
 * is the claimed mechanism (PAY-02).
 */

/** Mirrors paymentWebhookRecovery.postgres.test.ts's identical seedAgreement helper. */
async function seedAgreement(creditorProfileId: string, debtorProfileId: string, creatorUserId: string, principalMinorUnits: number): Promise<string> {
  const agreements = new DrizzleAgreementRepository();
  const created = await agreements.insert({
    creditorProfileKind: "personal",
    creditorProfileId,
    debtorProfileKind: "personal",
    debtorProfileId,
    currency: "USD",
    createdByUserId: creatorUserId,
  });
  const db = getDb();
  const [version] = await db
    .insert(agreementVersion)
    .values({
      agreementId: created.id,
      versionNumber: 1,
      isOriginal: true,
      producedBy: "wp01_payout_atomicity_postgres_test_seed",
      frequency: "monthly",
      feeAllocation: "creditor_pays",
      terms: { currentPrincipalMinorUnits: principalMinorUnits } as object,
    })
    .returning();
  if (!version) throw new Error("agreement_version insert returned no row");
  await db.update(agreement).set({ currentVersionId: version.id, status: "first_payment_pending" }).where(eq(agreement.id, created.id));
  return created.id;
}

async function seedTwoParties(principalMinorUnits = 10_000) {
  const creditor = await seedPersonalUser("wp01-payout-creditor");
  const debtor = await seedPersonalUser("wp01-payout-debtor");
  const agreementId = await seedAgreement(creditor.profileId, debtor.profileId, creditor.userId, principalMinorUnits);
  return { creditor, debtor, agreementId };
}

/**
 * Seeds a real, cleared payment — a durable `payment_cleared` ledger entry plus `succeeded` status —
 * the required precondition for payout-entitlement creation/confirmation. Mirrors
 * `postClearedForInstallment`'s identical technique in paymentWebhookRecovery.postgres.test.ts.
 */
async function seedClearedPayment(
  agreementId: string,
  debtor: { profileId: string },
  creditor: { profileId: string },
  amountMinorUnits = 5_000,
): Promise<{ id: string }> {
  const payments = new DrizzlePaymentAttemptRepository();
  const providerPaymentId = `sandbox_pay_${randomUUID()}`;
  const inserted = await payments.insertPending({
    idempotencyKey: randomUUID(),
    payerProfileKind: "personal",
    payerProfileId: debtor.profileId,
    recipientProfileKind: "personal",
    recipientProfileId: creditor.profileId,
    amountMinorUnits,
    currency: "USD",
    agreementId,
    providerName: "sandbox_mock",
  });
  const payment = await payments.updateStatus(inserted.id, "pending", { providerPaymentId });

  const ledger = new LedgerService({
    accounts: new DrizzleLedgerAccountRepository(),
    entries: new DrizzleLedgerJournalEntryRepository(),
    audit: new AuditService(new DrizzleAuditEventRepository()),
  });
  await ledger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: amountMinorUnits });
  const db = getDb();
  await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, payment.id));
  return { id: payment.id };
}

async function findPayoutAttemptRows(paymentAttemptId: string) {
  const db = getDb();
  return db.select().from(payoutAttempt).where(eq(payoutAttempt.paymentAttemptId, paymentAttemptId));
}

async function findPayoutLedgerEntries(paymentAttemptId: string, entryType: "payout" | "payout_returned") {
  const db = getDb();
  return db
    .select()
    .from(ledgerJournalEntry)
    .where(eq(ledgerJournalEntry.paymentAttemptId, paymentAttemptId))
    .then((rows) => rows.filter((r) => r.entryType === entryType));
}

function buildPayoutService(overrides: Partial<ConstructorParameters<typeof PayoutService>[0]> = {}): PayoutService {
  return new PayoutService({
    payoutAttempts: new DrizzlePayoutAttemptRepository(),
    ledger: new LedgerService({ accounts: new DrizzleLedgerAccountRepository(), entries: new DrizzleLedgerJournalEntryRepository(), audit: new AuditService(new DrizzleAuditEventRepository()) }),
    payments: new DrizzlePaymentAttemptRepository(),
    audit: new AuditService(new DrizzleAuditEventRepository()),
    verification: { isFullyVerified: async () => true },
    payoutProviderIntegrationVerified: true,
    ...overrides,
  });
}

/** Mirrors paymentWebhookRecovery.postgres.test.ts's identical createDeferred helper. */
function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("WP-01: payout concurrency and local atomicity proof (real Postgres)", () => {
  it("STAGE4-MIGRATION — ledger_entry_type enum parity: refund_correction and payout_returned are present, and every pre-existing value remains present, after migration 20260928000000_ledger_entry_type_stage4_parity.sql applies", async () => {
    const db = getDb();
    const rows = await db.execute<{ enumlabel: string }>(
      sql`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'ledger_entry_type' ORDER BY e.enumsortorder`,
    );
    const labels = rows.map((r) => r.enumlabel);
    // Pre-existing values (from 20260811131100_sprint10_ledger_reconciliation.sql) — untouched.
    expect(labels).toEqual(
      expect.arrayContaining(["payment_cleared", "refund", "reversal", "payout", "dispute_adjustment", "admin_adjustment"]),
    );
    // The two Stage 4 blocker-migration additions.
    expect(labels).toContain("refund_correction");
    expect(labels).toContain("payout_returned");
    expect(labels).toHaveLength(8); // exactly the six original values plus exactly these two — no unrelated addition.
  });

  it("PAY-01 — duplicate payout entitlement: two genuinely separate PostgreSQL connections, BOTH forced to observe the row as absent before either inserts, exercise the real unique-conflict recovery branch and resolve to exactly one durable payout row", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedClearedPayment(agreementId, debtor, creditor, 5_000);

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      // Step 9 (Stage 4 remediation order) — a test-only delegating wrapper, never a production
      // synchronization hook: pauses AFTER the real repository's own `findByPaymentAttemptId` call
      // resolves (observed absent), for exactly that call's FIRST invocation on each instance, so both
      // workers are provably past their initial existence check before either proceeds to insert.
      // Later calls (the catch-block's own re-query after a losing insert) pass straight through.
      class BarrierPayoutAttemptRepository implements PayoutAttemptRepository {
        private firstFindDone = false;
        insertCalls = 0;
        constructor(
          private readonly real: PayoutAttemptRepository,
          private readonly onFirstFindObservedAbsent: () => void,
          private readonly releaseGate: Promise<void>,
        ) {}
        async findByPaymentAttemptId(paymentAttemptId: string) {
          const result = await this.real.findByPaymentAttemptId(paymentAttemptId);
          if (!this.firstFindDone) {
            this.firstFindDone = true;
            this.onFirstFindObservedAbsent();
            await this.releaseGate;
          }
          return result;
        }
        async insert(input: { paymentAttemptId: string; agreementId: string }) {
          this.insertCalls += 1;
          return this.real.insert(input);
        }
        async markConfirmed(id: string, input: Parameters<PayoutAttemptRepository["markConfirmed"]>[1]) {
          return this.real.markConfirmed(id, input);
        }
        async markFailed(id: string, input: Parameters<PayoutAttemptRepository["markFailed"]>[1]) {
          return this.real.markFailed(id, input);
        }
        async markReturned(id: string, input: Parameters<PayoutAttemptRepository["markReturned"]>[1]) {
          return this.real.markReturned(id, input);
        }
      }

      const readyA = createDeferred<void>();
      const readyB = createDeferred<void>();
      const release = createDeferred<void>();
      const repoA = new BarrierPayoutAttemptRepository(new DrizzlePayoutAttemptRepository(isolatedA.db), () => readyA.resolve(), release.promise);
      const repoB = new BarrierPayoutAttemptRepository(new DrizzlePayoutAttemptRepository(isolatedB.db), () => readyB.resolve(), release.promise);
      const serviceA = buildPayoutService({ payoutAttempts: repoA });
      const serviceB = buildPayoutService({ payoutAttempts: repoB });

      // 1/2. Both workers' initial findByPaymentAttemptId is issued; each pauses, having observed absence.
      const promiseA = serviceA.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId });
      const promiseB = serviceB.recordPayoutOwed({ paymentAttemptId: payment.id, agreementId });
      await Promise.all([readyA.promise, readyB.promise]);
      // 3. Barrier releases both.
      release.resolve();
      // 4. Both attempt insertion.
      const [recordA, recordB] = await Promise.all([promiseA, promiseB]);

      // 5/6/7. PostgreSQL uniqueness permitted exactly one durable row; the losing insert followed the
      // real production conflict-recovery branch (both repos genuinely attempted insert — proven by
      // the counters — yet only one row exists); both logical calls resolved to the same identity.
      expect(repoA.insertCalls).toBe(1);
      expect(repoB.insertCalls).toBe(1);
      expect(recordA.id).toBe(recordB.id);
      expect(recordA.paymentAttemptId).toBe(payment.id);
      expect(recordA.status).toBe("pending");

      const rows = await findPayoutAttemptRows(payment.id);
      expect(rows).toHaveLength(1); // exactly one payout row — no duplicate economic entitlement.
      expect(rows[0]?.paymentAttemptId).toBe(payment.id);
      expect(rows[0]?.status).toBe("pending");
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("PAY-02 — duplicate payout confirmation: Worker A proven (via pg_stat_activity) to hold the payout_attempt row lock before Worker B's confirmation attempt starts, producing exactly one economic confirmation", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedClearedPayment(agreementId, debtor, creditor, 5_000);
    await new DrizzlePayoutAttemptRepository().insert({ paymentAttemptId: payment.id, agreementId });

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      await warmUp(isolatedA.client);
      const pidB = await warmUp(isolatedB.client);

      const workerAHoldsLock = createDeferred<void>();
      const releaseWorkerA = createDeferred<void>();
      const hooksA: AtomicPayoutConfirmerTestHooks = {
        afterLedgerPost: async () => {
          // Still inside Worker A's open transaction — the SELECT...FOR UPDATE granted earlier is
          // still held. Signal the test, then block until the test releases us, giving Worker B a
          // genuine, server-provable window to queue behind this exact row lock.
          workerAHoldsLock.resolve();
          await releaseWorkerA.promise;
        },
      };
      const confirmerA = new DrizzleAtomicPayoutConfirmer(isolatedA.db, hooksA);
      const confirmerB = new DrizzleAtomicPayoutConfirmer(isolatedB.db);

      const resultAPromise = confirmerA.confirmAtomically({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: `ref-a-${randomUUID()}` });
      await workerAHoldsLock.promise;

      const resultBPromise = confirmerB.confirmAtomically({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: `ref-b-${randomUUID()}` });
      // Server-side proof of real contention — Worker B's own SELECT...FOR UPDATE is genuinely
      // blocked in PostgreSQL, not merely issued close together in JS.
      await waitUntilPidBlockedOnLock(DATABASE_URL, pidB);

      releaseWorkerA.resolve();
      const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);

      const outcomes = [resultA.outcome, resultB.outcome].sort();
      expect(outcomes).toEqual(["already_confirmed", "confirmed"]); // exactly one real confirmation.

      const rows = await findPayoutAttemptRows(payment.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("confirmed");

      const payoutEntries = await findPayoutLedgerEntries(payment.id, "payout");
      expect(payoutEntries).toHaveLength(1); // exactly one payout ledger effect — no duplicate posting.

      const db = getDb();
      const paymentRow = (await db.select().from(paymentAttempt).where(eq(paymentAttempt.id, payment.id)))[0];
      expect(paymentRow?.payoutCompletedAt).not.toBeNull(); // populated exactly once economically.

      // Replay: a third, sequential call resolves through the current idempotent/already-confirmed
      // behavior, with no additional economic effect.
      const replay = await new DrizzleAtomicPayoutConfirmer().confirmAtomically({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-replay" });
      expect(replay.outcome).toBe("already_confirmed");
      const rowsAfterReplay = await findPayoutAttemptRows(payment.id);
      expect(rowsAfterReplay).toHaveLength(1);
      const payoutEntriesAfterReplay = await findPayoutLedgerEntries(payment.id, "payout");
      expect(payoutEntriesAfterReplay).toHaveLength(1);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("PAY-03 — confirmation transaction rollback: a deterministic failure after the ledger mutation but before commit leaves zero committed effect, and the retried confirmation then succeeds exactly once", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedClearedPayment(agreementId, debtor, creditor, 5_000);
    await new DrizzlePayoutAttemptRepository().insert({ paymentAttemptId: payment.id, agreementId });

    const failingHooks: AtomicPayoutConfirmerTestHooks = {
      afterLedgerPost: async () => {
        throw new Error("PAY-03: simulated failure after the payout ledger mutation, before commit");
      },
    };
    const failingConfirmer = new DrizzleAtomicPayoutConfirmer(undefined, failingHooks);
    await expect(failingConfirmer.confirmAtomically({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-fail" })).rejects.toThrow(
      "PAY-03: simulated failure",
    );

    // The whole transaction rolled back — no partial cross-table financial state of any kind.
    const rowsAfterFailure = await findPayoutAttemptRows(payment.id);
    expect(rowsAfterFailure).toHaveLength(1);
    expect(rowsAfterFailure[0]?.status).toBe("pending"); // remains the pre-confirmation value.
    expect(await findPayoutLedgerEntries(payment.id, "payout")).toHaveLength(0); // zero committed payout ledger rows.
    const db = getDb();
    const paymentRowAfterFailure = (await db.select().from(paymentAttempt).where(eq(paymentAttempt.id, payment.id)))[0];
    expect(paymentRowAfterFailure?.payoutCompletedAt).toBeNull(); // unchanged.

    // Retry with the real, non-failing confirmer — exactly one durable confirmation.
    const result = await new DrizzleAtomicPayoutConfirmer().confirmAtomically({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-retry" });
    expect(result.outcome).toBe("confirmed");
    const rowsAfterRetry = await findPayoutAttemptRows(payment.id);
    expect(rowsAfterRetry).toHaveLength(1);
    expect(rowsAfterRetry[0]?.status).toBe("confirmed");
    expect(await findPayoutLedgerEntries(payment.id, "payout")).toHaveLength(1);
  });

  it("PAY-04 — payout return: a confirmed payout transitions correctly to returned, with exactly one corrective ledger effect, and replay does not duplicate the correction", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedClearedPayment(agreementId, debtor, creditor, 5_000);
    await new DrizzlePayoutAttemptRepository().insert({ paymentAttemptId: payment.id, agreementId });
    const confirmed = await new DrizzleAtomicPayoutConfirmer().confirmAtomically({
      paymentAttemptId: payment.id,
      providerName: "sandbox_provider",
      providerPayoutReference: "ref-confirm",
    });
    expect(confirmed.outcome).toBe("confirmed");

    const returner = new DrizzleAtomicPayoutReturner();
    const result = await returner.returnAtomically({ paymentAttemptId: payment.id, reason: "PAY-04: bank returned the funds" });
    expect(result.outcome).toBe("returned");

    const rows = await findPayoutAttemptRows(payment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("returned");
    // Confirmation provenance preserved, never cleared.
    expect(rows[0]?.confirmedAt).not.toBeNull();
    expect(rows[0]?.providerName).toBe("sandbox_provider");

    const returnedEntries = await findPayoutLedgerEntries(payment.id, "payout_returned");
    expect(returnedEntries).toHaveLength(1); // exactly one corrective ledger effect.
    const confirmedEntries = await findPayoutLedgerEntries(payment.id, "payout");
    expect(confirmedEntries).toHaveLength(1); // original entry preserved, never rewritten.

    const db = getDb();
    const paymentRow = (await db.select().from(paymentAttempt).where(eq(paymentAttempt.id, payment.id)))[0];
    expect(paymentRow?.payoutCompletedAt).toBeNull(); // corrected — creditor delivery accounting reversed.

    // Replay: a second call to return must not duplicate the correction.
    const replay = await returner.returnAtomically({ paymentAttemptId: payment.id, reason: "PAY-04: replay" });
    expect(replay.outcome).toBe("already_returned");
    expect(await findPayoutLedgerEntries(payment.id, "payout_returned")).toHaveLength(1);
  });
});

/**
 * Stage 4 — Steps 7/8 (payout audit recovery). Wraps the REAL `DrizzleAuditEventRepository` and fails
 * its `appendAtomically` path (the one `AuditService.record()` actually calls in production — see
 * that class's own doc comment) exactly `failCount` times before delegating, mirroring
 * `paymentWebhookRecovery.postgres.test.ts`'s own established `flaky()` Proxy technique — no
 * production code is touched or given a test-only hook for this.
 */
class FlakyAuditEventRepository implements AuditEventRepository {
  private calls = 0;
  constructor(
    private readonly real: AuditEventRepository,
    private readonly failCount: number,
  ) {}

  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.real.getLastEvent();
  }

  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    return this.real.insertEvent(record);
  }

  async appendAtomically(payload: AuditEventPayload, computeHash: (previousEventHash: string | null) => string): Promise<AuditEventRecord> {
    this.calls += 1;
    if (this.calls <= this.failCount) {
      throw new Error("AUD: simulated audit write failure — the underlying financial effect has already committed");
    }
    return this.real.appendAtomically!(payload, computeHash);
  }

  /**
   * S4-03-FINAL: `PayoutService.confirmPayout`/`returnPayout` now call `AuditService.ensureRecorded`
   * on BOTH the first-time and replay branches, which prefers `ensureAtomically` over `record()`'s
   * own `appendAtomically` — so the flaky failure injection must apply here too, sharing the SAME
   * call counter as `appendAtomically` (conceptually "the audit write mechanism fails N times",
   * regardless of which entry point reaches it).
   */
  async ensureAtomically(
    identity: { targetResourceType: string; targetResourceId: string; action: string },
    payload: AuditEventPayload,
    computeHash: (previousEventHash: string | null) => string,
  ): Promise<{ event: AuditEventRecord; created: boolean }> {
    this.calls += 1;
    if (this.calls <= this.failCount) {
      throw new Error("AUD: simulated audit write failure — the underlying financial effect has already committed");
    }
    return this.real.ensureAtomically!(identity, payload, computeHash);
  }
}

function buildFlakyPayoutService(failCount: number) {
  const flakyRepo = new FlakyAuditEventRepository(new DrizzleAuditEventRepository(), failCount);
  const payoutService = new PayoutService({
    payoutAttempts: new DrizzlePayoutAttemptRepository(),
    ledger: new LedgerService({ accounts: new DrizzleLedgerAccountRepository(), entries: new DrizzleLedgerJournalEntryRepository(), audit: new AuditService(new DrizzleAuditEventRepository()) }),
    payments: new DrizzlePaymentAttemptRepository(),
    audit: new AuditService(flakyRepo),
    verification: { isFullyVerified: async () => true },
    payoutProviderIntegrationVerified: true,
    atomicConfirmer: new DrizzleAtomicPayoutConfirmer(),
    atomicReturner: new DrizzleAtomicPayoutReturner(),
    auditFinder: new DrizzleAdminAuditReader(),
  });
  return payoutService;
}

describe("Stage 4 — Steps 7/8: payout audit recovery after committed financial effect (real Postgres)", () => {
  it("AUD-01 — confirmation audit-write failure: retry repairs the missing audit event without reconfirming financially or duplicating the ledger effect", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedClearedPayment(agreementId, debtor, creditor, 5_000);
    await new DrizzlePayoutAttemptRepository().insert({ paymentAttemptId: payment.id, agreementId });

    const flakyService = buildFlakyPayoutService(1);
    await expect(
      flakyService.confirmPayout({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-aud-01" }),
    ).rejects.toThrow("AUD: simulated audit write failure");

    // The financial confirmation already committed, exactly once, despite the audit failure.
    const rowsAfterFailure = await findPayoutAttemptRows(payment.id);
    expect(rowsAfterFailure).toHaveLength(1);
    expect(rowsAfterFailure[0]?.status).toBe("confirmed");
    expect(await findPayoutLedgerEntries(payment.id, "payout")).toHaveLength(1);
    const auditBefore = await new DrizzleAdminAuditReader().listForTarget("payout_attempt", rowsAfterFailure[0]!.id);
    expect(auditBefore.filter((e) => e.action === "payout_confirmed")).toHaveLength(0); // genuinely missing.

    // Retry the SAME service operation — the flaky repository's one failure is already spent, so this
    // call reaches the "already_confirmed" replay branch and repairs the missing audit event.
    const retried = await flakyService.confirmPayout({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-aud-01-retry" });
    expect(retried.status).toBe("confirmed");

    // Financial confirmation and ledger effect remain exactly once — never repeated.
    const rowsAfterRetry = await findPayoutAttemptRows(payment.id);
    expect(rowsAfterRetry).toHaveLength(1);
    expect(rowsAfterRetry[0]?.status).toBe("confirmed");
    expect(await findPayoutLedgerEntries(payment.id, "payout")).toHaveLength(1);

    // The required audit event now exists, exactly once.
    const auditAfter = await new DrizzleAdminAuditReader().listForTarget("payout_attempt", rowsAfterRetry[0]!.id);
    const confirmedEvents = auditAfter.filter((e) => e.action === "payout_confirmed");
    expect(confirmedEvents).toHaveLength(1);
    // Repaired using the durable, persisted evidence, not the retry call's own (different) reference.
    expect((confirmedEvents[0]?.newValue as { providerPayoutReference?: string } | null)?.providerPayoutReference).toBe("ref-aud-01");

    // A further replay does not duplicate the audit event either.
    await flakyService.confirmPayout({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-aud-01-again" });
    const auditFinal = await new DrizzleAdminAuditReader().listForTarget("payout_attempt", rowsAfterRetry[0]!.id);
    expect(auditFinal.filter((e) => e.action === "payout_confirmed")).toHaveLength(1);
  });

  it("AUD-02 — return audit-write failure: retry repairs the missing return audit event without repeating the return or duplicating the corrective ledger effect", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedClearedPayment(agreementId, debtor, creditor, 5_000);
    await new DrizzlePayoutAttemptRepository().insert({ paymentAttemptId: payment.id, agreementId });
    // Confirm first via a non-flaky service, so only the RETURN's own audit write is under test.
    const setupService = buildFlakyPayoutService(0);
    const confirmed = await setupService.confirmPayout({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-aud-02-confirm" });
    expect(confirmed.status).toBe("confirmed");

    const flakyService = buildFlakyPayoutService(1);
    await expect(flakyService.returnPayout({ paymentAttemptId: payment.id, reason: "AUD-02: bank returned the funds" })).rejects.toThrow("AUD: simulated audit write failure");

    // The return financial effect already committed, exactly once, despite the audit failure.
    const rowsAfterFailure = await findPayoutAttemptRows(payment.id);
    expect(rowsAfterFailure).toHaveLength(1);
    expect(rowsAfterFailure[0]?.status).toBe("returned");
    expect(await findPayoutLedgerEntries(payment.id, "payout_returned")).toHaveLength(1);
    const auditBefore = await new DrizzleAdminAuditReader().listForTarget("payout_attempt", rowsAfterFailure[0]!.id);
    expect(auditBefore.filter((e) => e.action === "payout_returned")).toHaveLength(0); // genuinely missing.

    // Retry — reaches the "already_returned" replay branch and repairs the missing audit event.
    const retried = await flakyService.returnPayout({ paymentAttemptId: payment.id, reason: "AUD-02: retry" });
    expect(retried.status).toBe("returned");

    // Return financial effect and corrective ledger effect remain exactly once — never repeated.
    const rowsAfterRetry = await findPayoutAttemptRows(payment.id);
    expect(rowsAfterRetry).toHaveLength(1);
    expect(await findPayoutLedgerEntries(payment.id, "payout_returned")).toHaveLength(1);

    // The required return audit event now exists, exactly once.
    const auditAfter = await new DrizzleAdminAuditReader().listForTarget("payout_attempt", rowsAfterRetry[0]!.id);
    expect(auditAfter.filter((e) => e.action === "payout_returned")).toHaveLength(1);
  });

  /**
   * S4-03 remediation (final closure order) — proves the given audit_event row's `previousEventHash`
   * genuinely equals the immediately-preceding row's `eventHash` (by `id` order), the same "not a
   * fork" proof `auditService.postgres.test.ts`'s own R04 suite uses. Direct schema query, not the
   * admin reader (which doesn't expose ordering across the whole chain).
   */
  async function verifyChainLinkage(eventId: number): Promise<void> {
    const db = getDb();
    const [row] = await db.select().from(auditEvent).where(eq(auditEvent.id, eventId));
    expect(row).toBeDefined();
    if (row!.previousEventHash === null) return; // genesis row — nothing to link to.
    const [predecessor] = await db.select().from(auditEvent).where(eq(auditEvent.id, eventId - 1));
    expect(predecessor).toBeDefined();
    expect(row!.previousEventHash).toBe(predecessor!.eventHash);
  }

  it("AUD-CONCURRENT-01 — confirmation audit repair is atomic under genuine concurrent replay: exactly one payout_confirmed event, financial effect remains singular, hash chain remains valid", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedClearedPayment(agreementId, debtor, creditor, 5_000);
    await new DrizzlePayoutAttemptRepository().insert({ paymentAttemptId: payment.id, agreementId });

    // Financially confirm directly via the atomic confirmer — bypassing PayoutService.confirmPayout
    // entirely, so the required payout_confirmed audit event is genuinely absent (S4-03's exact
    // precondition), with no fault injection needed.
    const confirmed = await new DrizzleAtomicPayoutConfirmer().confirmAtomically({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-aud-concurrent-01" });
    expect(confirmed.outcome).toBe("confirmed");
    const auditBeforeRepair = await new DrizzleAdminAuditReader().listForTarget("payout_attempt", confirmed.record.id);
    expect(auditBeforeRepair.filter((e) => e.action === "payout_confirmed")).toHaveLength(0);

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const serviceA = buildPayoutService({
        atomicConfirmer: new DrizzleAtomicPayoutConfirmer(isolatedA.db),
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedA.db)),
        auditFinder: new DrizzleAdminAuditReader(),
      });
      const serviceB = buildPayoutService({
        atomicConfirmer: new DrizzleAtomicPayoutConfirmer(isolatedB.db),
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedB.db)),
        auditFinder: new DrizzleAdminAuditReader(),
      });

      // Two genuinely concurrent replay callers, each on its own real connection, both reaching the
      // "already_confirmed" repair branch (the payout was already confirmed above).
      const [resultA, resultB] = await Promise.all([
        serviceA.confirmPayout({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-aud-concurrent-01-a" }),
        serviceB.confirmPayout({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-aud-concurrent-01-b" }),
      ]);
      expect(resultA.status).toBe("confirmed"); // both replay calls complete per the service contract.
      expect(resultB.status).toBe("confirmed");

      const rows = await findPayoutAttemptRows(payment.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("confirmed");
      expect(await findPayoutLedgerEntries(payment.id, "payout")).toHaveLength(1); // financial effect remains singular.

      const auditAfter = await new DrizzleAdminAuditReader().listForTarget("payout_attempt", confirmed.record.id);
      const confirmedEvents = auditAfter.filter((e) => e.action === "payout_confirmed");
      expect(confirmedEvents).toHaveLength(1); // exactly one — the concurrent repair race is closed.
      await verifyChainLinkage(confirmedEvents[0]!.id);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("AUD-CONCURRENT-02 — return audit repair is atomic under genuine concurrent replay: exactly one payout_returned event, the return financial correction remains singular, hash chain remains valid", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedClearedPayment(agreementId, debtor, creditor, 5_000);
    await new DrizzlePayoutAttemptRepository().insert({ paymentAttemptId: payment.id, agreementId });
    const confirmed = await new DrizzleAtomicPayoutConfirmer().confirmAtomically({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-aud-concurrent-02-confirm" });
    expect(confirmed.outcome).toBe("confirmed");

    // Financially return directly via the atomic returner — bypassing PayoutService.returnPayout
    // entirely, so the required payout_returned audit event is genuinely absent.
    const returned = await new DrizzleAtomicPayoutReturner().returnAtomically({ paymentAttemptId: payment.id, reason: "AUD-CONCURRENT-02: bank returned the funds" });
    expect(returned.outcome).toBe("returned");
    const auditBeforeRepair = await new DrizzleAdminAuditReader().listForTarget("payout_attempt", returned.record.id);
    expect(auditBeforeRepair.filter((e) => e.action === "payout_returned")).toHaveLength(0);

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const serviceA = buildPayoutService({
        atomicReturner: new DrizzleAtomicPayoutReturner(isolatedA.db),
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedA.db)),
        auditFinder: new DrizzleAdminAuditReader(),
      });
      const serviceB = buildPayoutService({
        atomicReturner: new DrizzleAtomicPayoutReturner(isolatedB.db),
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedB.db)),
        auditFinder: new DrizzleAdminAuditReader(),
      });

      const [resultA, resultB] = await Promise.all([
        serviceA.returnPayout({ paymentAttemptId: payment.id, reason: "AUD-CONCURRENT-02: replay a" }),
        serviceB.returnPayout({ paymentAttemptId: payment.id, reason: "AUD-CONCURRENT-02: replay b" }),
      ]);
      expect(resultA.status).toBe("returned"); // both callers resolve safely.
      expect(resultB.status).toBe("returned");

      const rows = await findPayoutAttemptRows(payment.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("returned");
      expect(await findPayoutLedgerEntries(payment.id, "payout_returned")).toHaveLength(1); // the return correction remains singular.

      const auditAfter = await new DrizzleAdminAuditReader().listForTarget("payout_attempt", returned.record.id);
      const returnedEvents = auditAfter.filter((e) => e.action === "payout_returned");
      expect(returnedEvents).toHaveLength(1); // exactly one.
      await verifyChainLinkage(returnedEvents[0]!.id);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("AUD-INITIAL-RACE-01 — a genuinely-new confirmation racing a concurrent replay caller for the SAME payout: exactly one financial confirmation, one payout_confirmed event, hash chain valid", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedClearedPayment(agreementId, debtor, creditor, 5_000);
    await new DrizzlePayoutAttemptRepository().insert({ paymentAttemptId: payment.id, agreementId });
    // Deliberately NOT pre-confirmed — unlike AUD-CONCURRENT-01, both concurrent callers below race
    // for the payout_attempt row lock itself: exactly one will take the "newly confirmed" branch,
    // the other the "already_confirmed" replay branch — proving the S4-03-FINAL unification closes
    // the race BETWEEN those two different branches, not just within the replay branch alone.

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const serviceA = buildPayoutService({
        atomicConfirmer: new DrizzleAtomicPayoutConfirmer(isolatedA.db),
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedA.db)),
        auditFinder: new DrizzleAdminAuditReader(),
      });
      const serviceB = buildPayoutService({
        atomicConfirmer: new DrizzleAtomicPayoutConfirmer(isolatedB.db),
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedB.db)),
        auditFinder: new DrizzleAdminAuditReader(),
      });

      const [resultA, resultB] = await Promise.all([
        serviceA.confirmPayout({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-aud-initial-race-01-a" }),
        serviceB.confirmPayout({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-aud-initial-race-01-b" }),
      ]);
      expect(resultA.status).toBe("confirmed"); // both callers complete safely.
      expect(resultB.status).toBe("confirmed");

      const rows = await findPayoutAttemptRows(payment.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("confirmed");
      expect(await findPayoutLedgerEntries(payment.id, "payout")).toHaveLength(1); // one financial confirmation, one ledger effect.

      const auditAfter = await new DrizzleAdminAuditReader().listForTarget("payout_attempt", rows[0]!.id);
      const confirmedEvents = auditAfter.filter((e) => e.action === "payout_confirmed");
      expect(confirmedEvents).toHaveLength(1); // exactly one — regardless of which caller "won" the financial row lock.
      await verifyChainLinkage(confirmedEvents[0]!.id);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("AUD-INITIAL-RACE-02 — a genuinely-new return racing a concurrent replay caller for the SAME payout: exactly one return financial correction, one payout_returned event, hash chain valid", async () => {
    const { creditor, debtor, agreementId } = await seedTwoParties();
    const payment = await seedClearedPayment(agreementId, debtor, creditor, 5_000);
    await new DrizzlePayoutAttemptRepository().insert({ paymentAttemptId: payment.id, agreementId });
    const confirmed = await new DrizzleAtomicPayoutConfirmer().confirmAtomically({ paymentAttemptId: payment.id, providerName: "sandbox_provider", providerPayoutReference: "ref-aud-initial-race-02-confirm" });
    expect(confirmed.outcome).toBe("confirmed");
    // Deliberately NOT pre-returned — both concurrent callers below race for the row lock: one takes
    // the "newly returned" branch, the other the "already_returned" replay branch.

    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const serviceA = buildPayoutService({
        atomicReturner: new DrizzleAtomicPayoutReturner(isolatedA.db),
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedA.db)),
        auditFinder: new DrizzleAdminAuditReader(),
      });
      const serviceB = buildPayoutService({
        atomicReturner: new DrizzleAtomicPayoutReturner(isolatedB.db),
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedB.db)),
        auditFinder: new DrizzleAdminAuditReader(),
      });

      const [resultA, resultB] = await Promise.all([
        serviceA.returnPayout({ paymentAttemptId: payment.id, reason: "AUD-INITIAL-RACE-02: a" }),
        serviceB.returnPayout({ paymentAttemptId: payment.id, reason: "AUD-INITIAL-RACE-02: b" }),
      ]);
      expect(resultA.status).toBe("returned"); // both callers complete safely.
      expect(resultB.status).toBe("returned");

      const rows = await findPayoutAttemptRows(payment.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("returned");
      expect(await findPayoutLedgerEntries(payment.id, "payout_returned")).toHaveLength(1); // one return correction.

      const auditAfter = await new DrizzleAdminAuditReader().listForTarget("payout_attempt", rows[0]!.id);
      const returnedEvents = auditAfter.filter((e) => e.action === "payout_returned");
      expect(returnedEvents).toHaveLength(1); // exactly one.
      await verifyChainLinkage(returnedEvents[0]!.id);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });
});
