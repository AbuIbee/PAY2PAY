import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { agreement } from "@/db/schema";
import { eq } from "drizzle-orm";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { ConflictError } from "@/lib/errors";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import type { StaffService } from "@/lib/staff/staffService";
import { waitUntilPidBlockedOnLock } from "../../../test/postgres/lockBarrier";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { createIsolatedDb, warmUp } from "../../../test/postgres/testDb";
import { AgreementService, type AgreementServiceDeps, type DraftTermsInput } from "./agreementService";
import { DrizzleAgreementPartyRepository } from "./drizzleAgreementPartyRepository";
import { DrizzleAgreementRepository } from "./drizzleAgreementRepository";
import { DrizzleAgreementVersionRepository } from "./drizzleAgreementVersionRepository";
import { DrizzleInstallmentScheduleItemRepository } from "./drizzleInstallmentScheduleItemRepository";
import { DrizzleRevisionApplicationRepository } from "./drizzleRevisionApplicationRepository";
import { DrizzleSigningApplicationRepository } from "./drizzleSigningApplicationRepository";

const DATABASE_URL = process.env.DATABASE_URL!;

/**
 * FINAL corrective pass (Codex, two rounds):
 *
 * Round 1 — `reviseTermsBeforeSignature` (the pre-signature counter/revision loop) had the same
 * non-atomic defect `reviseFirstPaymentDate` was already fixed for: independent reads/writes with no
 * re-validation at the write boundary. Closed via `DrizzleRevisionApplicationRepository
 * .applyGeneralTermsRevisionAtomically` — see that method's own doc comment in
 * agreementService.ts.
 *
 * Round 2 — Codex correctly identified that `creditorDecide`'s ACCEPT transition was the other,
 * still-open half of this same race: an unconditional `updateStatus` after pre-transaction reads,
 * so a stale accept could silently overwrite a concurrent revision's committed result. Closed via
 * `DrizzleAgreementRepository.applyAcceptanceTransitionAtomically` — same lock order, same
 * re-validate-under-lock contract — see that method's own doc comment.
 *
 * Round 3 — Codex found `applyGeneralTermsRevisionAtomically`'s re-validation was still too broad:
 * it accepted EITHER of the two generally-revisable statuses (`awaiting_debtor_acknowledgment` OR
 * `awaiting_creditor_acceptance`), not the exact one the specific revision attempt was authorized
 * against. A stale DEBTOR revision (authorized only while `awaiting_debtor_acknowledgment`) could
 * read that status, pause, let a concurrent `acknowledgeDebt` advance the SAME version to
 * `awaiting_creditor_acceptance`, then resume and incorrectly pass revalidation because that status
 * was ALSO in the allowed set. Closed by narrowing the contract to a single `expectedStatus` — see
 * `RevisionApplicationRepository.applyGeneralTermsRevisionAtomically`'s own doc comment.
 *
 * This suite proves all three pairings with genuine, deterministic Postgres synchronization — not a
 * sequential approximation, not sleeps, not repeated-probability races — using the same
 * `AgreementLockTestHooks` mechanism already proven for R05-B/R05-C (see
 * signingConcurrency.postgres.test.ts), now also available on `DrizzleAgreementRepository`.
 */
const unusedStaffService = {
  requireActiveStaff: () => {
    throw new Error("not implemented — no business profile is ever used in this Postgres suite");
  },
  requireCapability: () => {
    throw new Error("not implemented — no business profile is ever used in this Postgres suite");
  },
} as unknown as StaffService;

function futureDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function baseTerms(firstPaymentDate: string): DraftTermsInput {
  return {
    category: "personal_loan",
    description: "Accept-vs-revision concurrency test agreement",
    originalAmountMinorUnits: 100_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 10_000,
    installmentAmountMinorUnits: 10_000,
    frequency: "monthly",
    firstPaymentDate,
    feeAllocation: "creditor_pays",
    earlyPayoffTerms: "none",
    hardshipRules: "none",
    partialPaymentRules: "none",
    settlementRules: "none",
    disputeProcedure: "none",
  };
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function buildDeps(overrides: Partial<AgreementServiceDeps> = {}): AgreementServiceDeps {
  return {
    agreements: new DrizzleAgreementRepository(),
    versions: new DrizzleAgreementVersionRepository(),
    parties: new DrizzleAgreementPartyRepository(),
    scheduleItems: new DrizzleInstallmentScheduleItemRepository(),
    profileOwners: new DrizzleProfileOwnerReader(),
    staffService: unusedStaffService,
    audit: new AuditService(new DrizzleAuditEventRepository()),
    signing: new DrizzleSigningApplicationRepository(),
    revisions: new DrizzleRevisionApplicationRepository(),
    ...overrides,
  };
}

async function fetchAgreementRow(agreementId: string) {
  const [row] = await getDb().select().from(agreement).where(eq(agreement.id, agreementId)).limit(1);
  if (!row) throw new Error("agreement row not found");
  return row;
}

describe("Accept vs general-revision race (real Postgres)", () => {
  async function buildAgreementAtAwaitingCreditorAcceptance() {
    const creditor = await seedPersonalUser("r-accept-revision-creditor");
    const debtor = await seedPersonalUser("r-accept-revision-debtor");
    const service = new AgreementService(buildDeps());
    const draft = await service.createDraft({
      creatorUserId: creditor.userId,
      creditor: { kind: "personal", id: creditor.profileId },
      debtor: { kind: "personal", id: debtor.profileId },
      ...baseTerms(futureDate(7)),
    });
    const agreementId = draft.agreement.id;
    await service.submitDraft(agreementId, creditor.userId);
    await service.acknowledgeDebt(agreementId, debtor.userId);
    const detail = await service.getAgreement(agreementId, creditor.userId);
    return {
      agreementId,
      originalVersionId: detail.version.id,
      creditorUserId: creditor.userId,
      debtorUserId: debtor.userId,
    };
  }

  it("Order A (deterministic, barrier-proven): revision wins first — accept genuinely blocks behind it, then fails safely once the revision commits", async () => {
    // 1. The counter-revision's real transaction is paused right after its `SELECT ... FOR UPDATE`
    //    on the `agreement` row is GRANTED (a direct signal from the driver's own await resolution).
    // 2/3. A real, independently-dispatched `accept` attempt is then proven — via `pg_stat_activity`,
    //    not a timing assumption — to genuinely block behind that held lock.
    // 4/5. The revision is released, commits (new version, currentVersionId repointed, status
    //    advanced to the correct review stage).
    // 6. Accept resumes, re-validates against the now-current row, and fails safely.
    const { agreementId, originalVersionId, creditorUserId } = await buildAgreementAtAwaitingCreditorAcceptance();
    const isolatedRevise = createIsolatedDb(DATABASE_URL);
    const isolatedAccept = createIsolatedDb(DATABASE_URL);
    try {
      const acceptPid = await warmUp(isolatedAccept.client);
      const lockAcquired = createDeferred<void>();
      const releaseRevision = createDeferred<void>();
      const counterService = new AgreementService(
        buildDeps({
          revisions: new DrizzleRevisionApplicationRepository(isolatedRevise.db, {
            afterAgreementLock: async () => {
              lockAcquired.resolve();
              await releaseRevision.promise;
            },
          }),
        }),
      );
      const acceptService = new AgreementService(buildDeps({ agreements: new DrizzleAgreementRepository(isolatedAccept.db) }));

      const counterPromise = counterService.creditorDecide({
        agreementId,
        actingUserId: creditorUserId,
        decision: "counter",
        counterTerms: baseTerms(futureDate(21)),
        reason: "Counter-proposing while a concurrent accept is attempted.",
      });
      await lockAcquired.promise; // deterministic: the revision's agreement-row lock has been GRANTED.

      const acceptPromise = acceptService
        .creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" })
        .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
      // Deterministic proof of real overlap: accept's own connection is genuinely queued, server-side,
      // behind the revision's held lock — `applyAcceptanceTransitionAtomically` needs the SAME
      // `agreement` row lock the revision's `SELECT ... FOR UPDATE` holds.
      await waitUntilPidBlockedOnLock(DATABASE_URL, acceptPid);

      releaseRevision.resolve();
      const [, acceptResult] = await Promise.all([counterPromise, acceptPromise]);

      expect(acceptResult.ok).toBe(false); // stale acceptance did not advance the lifecycle.
      if (!acceptResult.ok) expect(acceptResult.e).toBeInstanceOf(ConflictError);

      const finalAgreement = await fetchAgreementRow(agreementId);
      expect(finalAgreement.currentVersionId).not.toBe(originalVersionId); // repointed to the new, current revision (V2).
      expect(finalAgreement.status).toBe("awaiting_debtor_acknowledgment"); // remains in the correct revised-review state.
      expect(finalAgreement.status).not.toBe("awaiting_signatures"); // no stale V1 acceptance survives.
    } finally {
      await isolatedRevise.close();
      await isolatedAccept.close();
    }
  });

  it("Order B (deterministic, barrier-proven): accept wins first — the general revision genuinely blocks behind it, then fails safely once the acceptance commits", async () => {
    // Mirror image of Order A above: this time ACCEPT's transaction is the one paused, mid-flight,
    // genuinely holding the `agreement` row lock, while the counter-revision's own lock attempt is
    // proven genuinely blocked behind it before accept is allowed to proceed and commit.
    const { agreementId, originalVersionId, creditorUserId } = await buildAgreementAtAwaitingCreditorAcceptance();
    const isolatedAccept = createIsolatedDb(DATABASE_URL);
    const isolatedRevise = createIsolatedDb(DATABASE_URL);
    try {
      const revisePid = await warmUp(isolatedRevise.client);
      const lockAcquired = createDeferred<void>();
      const releaseAccept = createDeferred<void>();
      const acceptService = new AgreementService(
        buildDeps({
          agreements: new DrizzleAgreementRepository(isolatedAccept.db, {
            afterAgreementLock: async () => {
              lockAcquired.resolve();
              await releaseAccept.promise;
            },
          }),
        }),
      );
      const counterService = new AgreementService(buildDeps({ revisions: new DrizzleRevisionApplicationRepository(isolatedRevise.db) }));

      const acceptPromise = acceptService
        .creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" })
        .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
      await lockAcquired.promise; // deterministic: accept's agreement-row lock has been GRANTED.

      const counterPromise = counterService
        .creditorDecide({
          agreementId,
          actingUserId: creditorUserId,
          decision: "counter",
          counterTerms: baseTerms(futureDate(21)),
          reason: "Trying to counter while a concurrent accept holds the lock.",
        })
        .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
      // Deterministic proof of real overlap: the revision's own connection is genuinely queued,
      // server-side, behind accept's held lock — not a timing assumption.
      await waitUntilPidBlockedOnLock(DATABASE_URL, revisePid);

      releaseAccept.resolve();
      const [acceptResult, counterResult] = await Promise.all([acceptPromise, counterPromise]);

      expect(acceptResult.ok).toBe(true); // the accepted lifecycle state remains intact.
      expect(counterResult.ok).toBe(false); // the stale revision does not repoint currentVersionId.
      if (!counterResult.ok) expect(counterResult.e).toBeInstanceOf(ConflictError);

      const finalAgreement = await fetchAgreementRow(agreementId);
      expect(finalAgreement.status).toBe("awaiting_signatures"); // no completed/advanced state is reverted.
      expect(finalAgreement.currentVersionId).toBe(originalVersionId); // no unsigned revised version becomes current.
    } finally {
      await isolatedAccept.close();
      await isolatedRevise.close();
    }
  });
});

describe("Debtor revision vs debt acknowledgment race (real Postgres)", () => {
  async function buildAgreementAtAwaitingDebtorAcknowledgment() {
    const creditor = await seedPersonalUser("r-debtor-revision-creditor");
    const debtor = await seedPersonalUser("r-debtor-revision-debtor");
    const service = new AgreementService(buildDeps());
    const draft = await service.createDraft({
      creatorUserId: creditor.userId,
      creditor: { kind: "personal", id: creditor.profileId },
      debtor: { kind: "personal", id: debtor.profileId },
      ...baseTerms(futureDate(7)),
    });
    const agreementId = draft.agreement.id;
    await service.submitDraft(agreementId, creditor.userId);
    const detail = await service.getAgreement(agreementId, creditor.userId);
    return {
      agreementId,
      originalVersionId: detail.version.id,
      debtorUserId: debtor.userId,
    };
  }

  it("ACKNOWLEDGMENT WINS (deterministic via pre-lock test hook): a stale debtor revision authorized against awaiting_debtor_acknowledgment must not commit merely because awaiting_creditor_acceptance is also a generally-revisable status", async () => {
    // The exact unsafe interleaving this proves impossible: a debtor revision reads
    // `awaiting_debtor_acknowledgment` + version V1 and is authorized against that EXACT status;
    // before its transaction can acquire the agreement-row lock, a concurrent `acknowledgeDebt`
    // advances the SAME version to `awaiting_creditor_acceptance`; the stale revision must NOT then
    // be allowed to commit merely because `awaiting_creditor_acceptance` is ALSO a generally-
    // revisable status — `expectedStatus` (the exact status this specific attempt was authorized
    // against) must be checked, not "any status a revision could generally start from".
    //
    // The debtor revision's real transaction is paused, via `beforeAgreementLock`, BEFORE it ever
    // requests the `agreement` row lock — so its Postgres transaction (BEGIN already sent) is
    // genuinely open and alive at the same wall-clock time the real, independent `acknowledgeDebt`
    // action runs to completion uncontended. The revision is then released and must reload fresh
    // state and fail safely against it.
    const { agreementId, originalVersionId, debtorUserId } = await buildAgreementAtAwaitingDebtorAcknowledgment();
    const isolatedRevise = createIsolatedDb(DATABASE_URL);
    try {
      const enteredTransaction = createDeferred<void>();
      const releaseRevision = createDeferred<void>();
      const debtorService = new AgreementService(
        buildDeps({
          revisions: new DrizzleRevisionApplicationRepository(isolatedRevise.db, {
            beforeAgreementLock: async () => {
              enteredTransaction.resolve();
              await releaseRevision.promise;
            },
          }),
        }),
      );
      const ackService = new AgreementService(buildDeps());

      const revisionPromise = debtorService
        .reviseTermsBeforeSignature({
          agreementId,
          actingUserId: debtorUserId,
          newTerms: baseTerms(futureDate(30)),
          reason: "Debtor proposing different terms.",
        })
        .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
      await enteredTransaction.promise; // the debtor's revision transaction is open but has not yet requested the agreement row lock.

      // Acknowledgment runs to completion, fully uncontended, advancing the SAME version to the
      // other party's review status — exactly the "another generally allowed review status" the
      // stale revision must not be fooled by.
      await ackService.acknowledgeDebt(agreementId, debtorUserId);
      const afterAck = await fetchAgreementRow(agreementId);
      expect(afterAck.status).toBe("awaiting_creditor_acceptance");
      expect(afterAck.currentVersionId).toBe(originalVersionId); // acknowledgment never touches the version.

      releaseRevision.resolve();
      const revisionResult = await revisionPromise;

      expect(revisionResult.ok).toBe(false); // the stale debtor-turn revision must not survive.
      if (!revisionResult.ok) expect(revisionResult.e).toBeInstanceOf(ConflictError);

      const finalAgreement = await fetchAgreementRow(agreementId);
      expect(finalAgreement.status).toBe("awaiting_creditor_acceptance"); // remains exactly what acknowledgment produced.
      expect(finalAgreement.currentVersionId).toBe(originalVersionId); // no stale revised version becomes current.
    } finally {
      await isolatedRevise.close();
    }
  });
});
