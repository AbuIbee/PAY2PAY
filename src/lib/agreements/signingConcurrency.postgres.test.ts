import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, signatureEvent } from "@/db/schema";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { ConflictError, CounterpartyMustSignFirstError, ValidationError } from "@/lib/errors";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import type { StaffService } from "@/lib/staff/staffService";
import { waitUntilPidBlockedOnLock } from "../../../test/postgres/lockBarrier";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { createIsolatedDb, warmUp } from "../../../test/postgres/testDb";
import { AgreementService, type AgreementTerms, type SigningEvidenceInput } from "./agreementService";
import { computeVersionHash } from "./documentHash";
import { DrizzleAgreementPartyRepository } from "./drizzleAgreementPartyRepository";
import { DrizzleAgreementRepository } from "./drizzleAgreementRepository";
import { DrizzleAgreementVersionRepository } from "./drizzleAgreementVersionRepository";
import { DrizzleInstallmentScheduleItemRepository } from "./drizzleInstallmentScheduleItemRepository";
import { DrizzleRevisionApplicationRepository } from "./drizzleRevisionApplicationRepository";
import { DrizzleSigningApplicationRepository } from "./drizzleSigningApplicationRepository";

const DATABASE_URL = process.env.DATABASE_URL!;

/**
 * R05 (DB integrity & concurrency hardening) — real-Postgres proof for
 * `AgreementService.signAgreementWithEvidence` + `DrizzleSigningApplicationRepository`'s
 * transactional revalidation, and (corrective pass, Codex finding G)
 * `DrizzleRevisionApplicationRepository`'s matching coordination. Every repository wired below is
 * the real Drizzle implementation against a real, disposable Postgres — only `staffService` is a
 * stub, and it is never actually called: every agreement in this file is personal-to-personal, and
 * `AgreementService.authorizeParty` only consults `staffService` on its business-profile branch.
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

/**
 * FINAL corrective pass (R05-B/R05-C determinism): a plain resolvable promise, used to pause a real
 * transaction at an exact, known point via `AgreementLockTestHooks` (see
 * drizzleSigningApplicationRepository.ts) and to signal, back to the test, the exact moment that
 * transaction reached that point — both signals come directly from the driver's own await
 * resolution, not from a sleep or a guess.
 */
function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function evidenceFor(userId: string, profileId: string, role: "creditor" | "debtor"): SigningEvidenceInput {
  return {
    signerUserId: userId,
    signerProfileKind: "personal",
    signerProfileId: profileId,
    signerRole: role,
    signingAuthority: null,
    signerTitle: null,
    consentCaptured: true,
    consentVersion: "v1",
    authMethod: "totp",
    ipAddress: "127.0.0.1",
    deviceInfo: null,
    timezone: "UTC",
  };
}

function buildAgreementService() {
  return new AgreementService({
    agreements: new DrizzleAgreementRepository(),
    versions: new DrizzleAgreementVersionRepository(),
    parties: new DrizzleAgreementPartyRepository(),
    scheduleItems: new DrizzleInstallmentScheduleItemRepository(),
    profileOwners: new DrizzleProfileOwnerReader(),
    staffService: unusedStaffService,
    audit: new AuditService(new DrizzleAuditEventRepository()),
    signing: new DrizzleSigningApplicationRepository(),
    revisions: new DrizzleRevisionApplicationRepository(),
  });
}

describe("R05: AgreementService signing/revision transactional coordination (real Postgres)", () => {
  let agreementService: AgreementService;
  let creditorUserId: string;
  let creditorProfileId: string;
  let debtorUserId: string;
  let debtorProfileId: string;

  beforeEach(async () => {
    agreementService = buildAgreementService();
    const creditor = await seedPersonalUser("r05-creditor");
    const debtor = await seedPersonalUser("r05-debtor");
    creditorUserId = creditor.userId;
    creditorProfileId = creditor.profileId;
    debtorUserId = debtor.userId;
    debtorProfileId = debtor.profileId;
  });

  /** Creator (creditor) -> submit -> debtor acknowledges -> creditor accepts -> awaiting_signatures. originatorRole is always "creditor" here, so the debtor (counterparty) must sign first. */
  async function buildAgreementAtAwaitingSignatures(daysUntilFirstPayment = 7) {
    const draft = await agreementService.createDraft({
      creatorUserId: creditorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      category: "personal_loan",
      description: "R05 postgres concurrency test agreement",
      originalAmountMinorUnits: 100_000,
      previousPaymentsMinorUnits: 0,
      firstPaymentMinorUnits: 10_000,
      installmentAmountMinorUnits: 10_000,
      frequency: "monthly",
      firstPaymentDate: futureDate(daysUntilFirstPayment),
      feeAllocation: "creditor_pays",
      earlyPayoffTerms: "none",
      hardshipRules: "none",
      partialPaymentRules: "none",
      settlementRules: "none",
      disputeProcedure: "none",
    });
    const agreementId = draft.agreement.id;
    await agreementService.submitDraft(agreementId, creditorUserId);
    await agreementService.acknowledgeDebt(agreementId, debtorUserId);
    await agreementService.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });
    const detail = await agreementService.getAgreement(agreementId, creditorUserId);
    return { agreementId, versionId: detail.version.id };
  }

  /** Counterparty (debtor) signs, leaving only the originator's (creditor's) completing signature. */
  async function buildAgreementWithOneSignatureRemaining() {
    const { agreementId, versionId } = await buildAgreementAtAwaitingSignatures();
    await agreementService.signAgreementWithEvidence(agreementId, debtorUserId, evidenceFor(debtorUserId, debtorProfileId, "debtor"));
    return { agreementId, versionId };
  }

  async function fetchAgreementRow(agreementId: string) {
    const [row] = await getDb().select().from(agreement).where(eq(agreement.id, agreementId)).limit(1);
    if (!row) throw new Error("agreement row not found");
    return row;
  }

  async function fetchVersionRow(versionId: string) {
    const [row] = await getDb().select().from(agreementVersion).where(eq(agreementVersion.id, versionId)).limit(1);
    if (!row) throw new Error("agreement_version row not found");
    return row;
  }

  async function signatureEventsForVersion(versionId: string) {
    return getDb().select().from(signatureEvent).where(eq(signatureEvent.agreementVersionId, versionId));
  }

  /** A trivial, valid revision payload against `baseVersionId`'s current terms, with a new date. */
  async function buildRevisionInput(baseVersionId: string, newFirstPaymentDate: string) {
    const versionRow = await fetchVersionRow(baseVersionId);
    const terms = versionRow.terms as AgreementTerms;
    return {
      baseVersionId,
      frequency: versionRow.frequency,
      feeAllocation: versionRow.feeAllocation,
      terms: { ...terms, firstPaymentDate: newFirstPaymentDate },
      schedule: [{ sequenceNumber: 1, dueDate: newFirstPaymentDate, amountMinorUnits: terms.firstPaymentMinorUnits }],
    };
  }

  describe("R05-A: duplicate-signing race", () => {
    it("sequential regression: AgreementService rejects a repeat signing request for an already-signed role", async () => {
      const { agreementId, versionId } = await buildAgreementAtAwaitingSignatures();
      await agreementService.signAgreementWithEvidence(agreementId, debtorUserId, evidenceFor(debtorUserId, debtorProfileId, "debtor"));
      await expect(
        agreementService.signAgreementWithEvidence(agreementId, debtorUserId, evidenceFor(debtorUserId, debtorProfileId, "debtor")),
      ).rejects.toThrow(ValidationError);
      expect(await signatureEventsForVersion(versionId)).toHaveLength(1);
    });

    it("TRUE race: two duplicate signing requests on genuinely distinct connections — exactly one is recorded, repeated across several real concurrent trials", async () => {
      // Corrective pass (Codex finding B/C): each iteration fires two REAL, independent Postgres
      // connections at the exact same (agreementId, versionId, role) with no client-side
      // synchronization at all — genuine OS/network-level concurrency, not a client-side barrier
      // (the row-lock barrier used for R05-B/C below is deliberately not used here: forcing a
      // specific dispatch order does not reliably determine which real connection's lock request
      // the Postgres server actually queues first — see the R05-B/C tests, which are outcome-
      // adaptive for exactly this reason). Repeating several times makes it very likely to actually
      // exercise a genuine overlap at least once, and the invariant must hold every single time
      // regardless of which connection's request the server happened to queue first.
      for (let attempt = 0; attempt < 8; attempt++) {
        const { agreementId, versionId } = await buildAgreementAtAwaitingSignatures();
        const isolatedA = createIsolatedDb(DATABASE_URL);
        const isolatedB = createIsolatedDb(DATABASE_URL);
        try {
          const signingA = new DrizzleSigningApplicationRepository(isolatedA.db);
          const signingB = new DrizzleSigningApplicationRepository(isolatedB.db);
          const evidence = evidenceFor(debtorUserId, debtorProfileId, "debtor");
          const input = { agreementId, agreementVersionId: versionId, role: "debtor" as const, originatorRole: "creditor" as const, signedAt: new Date(), evidence };

          const [resultA, resultB] = await Promise.all([signingA.applySigningAtomically(input), signingB.applySigningAtomically(input)]);
          const alreadySignedFlags = [resultA.alreadySigned, resultB.alreadySigned].sort();
          expect(alreadySignedFlags).toEqual([false, true]); // exactly one won, one correctly detected the race and recorded nothing.

          const versionRow = await fetchVersionRow(versionId);
          expect(versionRow.debtorSignedAt).not.toBeNull();
          const events = await signatureEventsForVersion(versionId);
          expect(events.filter((e) => e.signerRole === "debtor")).toHaveLength(1); // exactly one signature event, never two.
        } finally {
          await isolatedA.close();
          await isolatedB.close();
        }
      }
    });
  });

  describe("R05-B: sign-vs-revision race", () => {
    it("sequential regression (stale-version rejection): calling the repository directly with a version a revision has already superseded is rejected, writing nothing", async () => {
      const { agreementId, versionId: staleVersionId } = await buildAgreementAtAwaitingSignatures();
      await agreementService.reviseFirstPaymentDate({ agreementId, actingUserId: debtorUserId, newFirstPaymentDate: futureDate(14) });
      const agreementRow = await fetchAgreementRow(agreementId);
      expect(agreementRow.currentVersionId).not.toBe(staleVersionId);

      const signing = new DrizzleSigningApplicationRepository();
      await expect(
        signing.applySigningAtomically({
          agreementId,
          agreementVersionId: staleVersionId,
          role: "debtor",
          originatorRole: "creditor",
          signedAt: new Date(),
          evidence: evidenceFor(debtorUserId, debtorProfileId, "debtor"),
        }),
      ).rejects.toThrow(ConflictError);

      const staleVersionRow = await fetchVersionRow(staleVersionId);
      expect(staleVersionRow.debtorSignedAt).toBeNull();
      expect(await signatureEventsForVersion(staleVersionId)).toHaveLength(0);
    });

    it("Order A (deterministic, barrier-proven): signing holds the agreement lock first — revision genuinely blocks behind it, then fails safely once signing commits", async () => {
      // FINAL corrective pass (Codex: "prove both critical operations overlap" + exercise BOTH
      // valid winning orders deterministically — repeated probability-based races are insufficient).
      // `afterAgreementLock` pauses signing's real transaction the instant its `SELECT ... FOR
      // UPDATE` on the `agreement` row is GRANTED (a direct signal from the driver's own await
      // resolution, not a guess) — from that point until the hook resolves, signing genuinely holds
      // that row lock. Only then is revision's real transaction dispatched; `waitUntilPidBlockedOnLock`
      // proves, via `pg_stat_activity`, that revision's own attempt to lock the SAME row is genuinely
      // blocked — not merely issued — before signing is allowed to proceed and commit.
      const { agreementId, versionId } = await buildAgreementWithOneSignatureRemaining();
      const isolatedSign = createIsolatedDb(DATABASE_URL);
      const isolatedRevise = createIsolatedDb(DATABASE_URL);
      try {
        const revisePid = await warmUp(isolatedRevise.client);
        const lockAcquired = createDeferred<void>();
        const releaseSigning = createDeferred<void>();
        const signing = new DrizzleSigningApplicationRepository(isolatedSign.db, {
          afterAgreementLock: async () => {
            lockAcquired.resolve();
            await releaseSigning.promise;
          },
        });
        const revisions = new DrizzleRevisionApplicationRepository(isolatedRevise.db);
        const revisionInput = await buildRevisionInput(versionId, futureDate(30));

        const signPromise = signing.applySigningAtomically({
          agreementId,
          agreementVersionId: versionId,
          role: "creditor",
          originatorRole: "creditor",
          signedAt: new Date(),
          evidence: evidenceFor(creditorUserId, creditorProfileId, "creditor"),
        });
        await lockAcquired.promise; // deterministic: signing's agreement-row lock has been GRANTED.

        const revisePromise = revisions.applyFirstPaymentDateRevisionAtomically({ agreementId, ...revisionInput });
        // Deterministic proof of real overlap: revision's own connection is genuinely queued,
        // server-side, behind signing's held lock — not a timing assumption.
        await waitUntilPidBlockedOnLock(DATABASE_URL, revisePid);

        releaseSigning.resolve();
        const [signResult, reviseResult] = await Promise.allSettled([signPromise, revisePromise]);

        expect(signResult.status).toBe("fulfilled");
        if (signResult.status === "fulfilled") expect(signResult.value.bothSigned).toBe(true);
        expect(reviseResult.status).toBe("rejected");
        if (reviseResult.status === "rejected") expect(reviseResult.reason).toBeInstanceOf(ConflictError);

        const finalAgreement = await fetchAgreementRow(agreementId);
        const finalVersion = await fetchVersionRow(versionId);
        expect(finalAgreement.status).toBe("first_payment_pending");
        expect(finalAgreement.currentVersionId).toBe(versionId); // never left pointing at an unsigned revision.
        expect(finalVersion.signedAt).not.toBeNull();
      } finally {
        await isolatedSign.close();
        await isolatedRevise.close();
      }
    });

    it("Order B (deterministic, barrier-proven): revision holds the agreement lock first — signing genuinely blocks behind it, then fails safely once revision commits", async () => {
      // Mirror image of Order A above: this time REVISION's transaction is the one paused, mid-flight,
      // genuinely holding the `agreement` row lock, while SIGNING's own lock attempt is proven
      // genuinely blocked behind it before revision is allowed to proceed and commit.
      const { agreementId, versionId } = await buildAgreementWithOneSignatureRemaining();
      const isolatedSign = createIsolatedDb(DATABASE_URL);
      const isolatedRevise = createIsolatedDb(DATABASE_URL);
      try {
        const signPid = await warmUp(isolatedSign.client);
        const lockAcquired = createDeferred<void>();
        const releaseRevision = createDeferred<void>();
        const signing = new DrizzleSigningApplicationRepository(isolatedSign.db);
        const revisions = new DrizzleRevisionApplicationRepository(isolatedRevise.db, {
          afterAgreementLock: async () => {
            lockAcquired.resolve();
            await releaseRevision.promise;
          },
        });
        const revisionInput = await buildRevisionInput(versionId, futureDate(30));

        const revisePromise = revisions.applyFirstPaymentDateRevisionAtomically({ agreementId, ...revisionInput });
        await lockAcquired.promise; // deterministic: revision's agreement-row lock has been GRANTED.

        const signPromise = signing.applySigningAtomically({
          agreementId,
          agreementVersionId: versionId,
          role: "creditor",
          originatorRole: "creditor",
          signedAt: new Date(),
          evidence: evidenceFor(creditorUserId, creditorProfileId, "creditor"),
        });
        // Deterministic proof of real overlap: signing's own connection is genuinely queued,
        // server-side, behind revision's held lock — not a timing assumption.
        await waitUntilPidBlockedOnLock(DATABASE_URL, signPid);

        releaseRevision.resolve();
        const [reviseResult, signResult] = await Promise.allSettled([revisePromise, signPromise]);

        expect(reviseResult.status).toBe("fulfilled");
        const newVersionId = reviseResult.status === "fulfilled" ? reviseResult.value.newVersionId : undefined;
        expect(signResult.status).toBe("rejected");
        if (signResult.status === "rejected") expect(signResult.reason).toBeInstanceOf(ConflictError);

        const finalAgreement = await fetchAgreementRow(agreementId);
        const staleVersion = await fetchVersionRow(versionId);
        expect(finalAgreement.status).toBe("awaiting_signatures"); // never became first_payment_pending on the stale version.
        expect(finalAgreement.currentVersionId).toBe(newVersionId);
        expect(staleVersion.creditorSignedAt).toBeNull(); // no signature survives against superseded terms.
        expect(await signatureEventsForVersion(versionId)).toHaveLength(1); // only the pre-existing debtor signature.
      } finally {
        await isolatedSign.close();
        await isolatedRevise.close();
      }
    });
  });

  describe("R05-C: sign-vs-cancellation race", () => {
    it("sequential regression: a signature can never be committed to an agreement cancellation already made ineligible", async () => {
      const { agreementId, versionId } = await buildAgreementAtAwaitingSignatures();
      await agreementService.cancelAgreement(agreementId, creditorUserId, "no longer proceeding");
      await expect(
        agreementService.signAgreementWithEvidence(agreementId, debtorUserId, evidenceFor(debtorUserId, debtorProfileId, "debtor")),
      ).rejects.toThrow(ValidationError);
      expect(await signatureEventsForVersion(versionId)).toHaveLength(0);
      expect((await fetchAgreementRow(agreementId)).status).toBe("mutually_canceled");
    });

    it("sequential regression: cancellation can never blindly overwrite an agreement a completed signature already advanced", async () => {
      const { agreementId, versionId } = await buildAgreementAtAwaitingSignatures();
      await agreementService.signAgreementWithEvidence(agreementId, debtorUserId, evidenceFor(debtorUserId, debtorProfileId, "debtor"));
      await agreementService.signAgreementWithEvidence(agreementId, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor"));
      expect((await fetchAgreementRow(agreementId)).status).toBe("first_payment_pending");
      await expect(agreementService.cancelAgreement(agreementId, creditorUserId, "too late")).rejects.toThrow(ValidationError);
      expect((await fetchAgreementRow(agreementId)).status).toBe("first_payment_pending");
      expect(await signatureEventsForVersion(versionId)).toHaveLength(2);
    });

    it("Order A (deterministic, barrier-proven): signing holds the agreement lock first — cancellation genuinely blocks behind it, then fails safely once signing commits", async () => {
      // FINAL corrective pass (Codex: "prove both critical operations overlap" for R05-C too).
      // `updateStatusIfCurrentlyIn` is a single atomic `UPDATE ... WHERE status IN (...)` — it still
      // needs the SAME `agreement` row lock signing's `SELECT ... FOR UPDATE` holds, so pausing
      // signing right after that lock is granted (via `afterAgreementLock`) forces cancellation's
      // real UPDATE to genuinely queue behind it — proven via `pg_stat_activity`, not assumed.
      const { agreementId, versionId } = await buildAgreementWithOneSignatureRemaining();
      const isolatedSign = createIsolatedDb(DATABASE_URL);
      const isolatedCancel = createIsolatedDb(DATABASE_URL);
      try {
        const cancelPid = await warmUp(isolatedCancel.client);
        const lockAcquired = createDeferred<void>();
        const releaseSigning = createDeferred<void>();
        const signing = new DrizzleSigningApplicationRepository(isolatedSign.db, {
          afterAgreementLock: async () => {
            lockAcquired.resolve();
            await releaseSigning.promise;
          },
        });
        const agreementsRepo = new DrizzleAgreementRepository(isolatedCancel.db);
        const cancellableStatuses = ["awaiting_debtor_acknowledgment", "awaiting_creditor_acceptance", "awaiting_signatures"] as const;

        const signPromise = signing.applySigningAtomically({
          agreementId,
          agreementVersionId: versionId,
          role: "creditor",
          originatorRole: "creditor",
          signedAt: new Date(),
          evidence: evidenceFor(creditorUserId, creditorProfileId, "creditor"),
        });
        await lockAcquired.promise; // deterministic: signing's agreement-row lock has been GRANTED.

        const cancelPromise = agreementsRepo.updateStatusIfCurrentlyIn(agreementId, cancellableStatuses, "mutually_canceled");
        // Deterministic proof of real overlap: cancellation's own connection is genuinely queued,
        // server-side, behind signing's held lock — not a timing assumption.
        await waitUntilPidBlockedOnLock(DATABASE_URL, cancelPid);

        releaseSigning.resolve();
        const [signResult, cancelled] = await Promise.all([signPromise, cancelPromise]);

        expect(signResult.bothSigned).toBe(true);
        expect(cancelled).toBe(false); // blocked, then — once unblocked — found the agreement no longer cancellable.

        const finalAgreement = await fetchAgreementRow(agreementId);
        expect(finalAgreement.status).toBe("first_payment_pending");
        expect(await signatureEventsForVersion(versionId)).toHaveLength(2);
      } finally {
        await isolatedSign.close();
        await isolatedCancel.close();
      }
    });

    it("Order B (deterministic via pre-lock test hook): cancellation completes first while signing's real transaction is open but paused before requesting the lock — signing then reloads and fails safely", async () => {
      // `updateStatusIfCurrentlyIn`'s single-statement UPDATE has no natural mid-flight pause point
      // of its own to hook into (unlike signing/revision's multi-statement transactions) — so this
      // order is proven the other direction: signing's real transaction is paused via
      // `beforeAgreementLock`, BEFORE it ever requests the agreement row lock, so its Postgres
      // transaction (BEGIN already sent) is genuinely open and alive at the same wall-clock time
      // cancellation's real, independent operation runs to completion uncontended. Signing is then
      // released and must reload fresh state and fail safely against it — no lock contention is
      // needed to prove this order, since nothing else holds the row while cancellation runs.
      const { agreementId, versionId } = await buildAgreementWithOneSignatureRemaining();
      const isolatedSign = createIsolatedDb(DATABASE_URL);
      const isolatedCancel = createIsolatedDb(DATABASE_URL);
      try {
        const enteredTransaction = createDeferred<void>();
        const releaseSigning = createDeferred<void>();
        const signing = new DrizzleSigningApplicationRepository(isolatedSign.db, {
          beforeAgreementLock: async () => {
            enteredTransaction.resolve();
            await releaseSigning.promise;
          },
        });
        const agreementsRepo = new DrizzleAgreementRepository(isolatedCancel.db);
        const cancellableStatuses = ["awaiting_debtor_acknowledgment", "awaiting_creditor_acceptance", "awaiting_signatures"] as const;

        const signPromise = signing.applySigningAtomically({
          agreementId,
          agreementVersionId: versionId,
          role: "creditor",
          originatorRole: "creditor",
          signedAt: new Date(),
          evidence: evidenceFor(creditorUserId, creditorProfileId, "creditor"),
        });
        await enteredTransaction.promise; // signing's transaction is open but has not yet requested the agreement row lock.

        const cancelled = await agreementsRepo.updateStatusIfCurrentlyIn(agreementId, cancellableStatuses, "mutually_canceled");
        expect(cancelled).toBe(true); // uncontended: nothing else holds the row yet.

        releaseSigning.resolve();
        const signResult = await signPromise.then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        );

        expect(signResult.ok).toBe(false);
        if (!signResult.ok) expect(signResult.e).toBeInstanceOf(ConflictError);

        const finalAgreement = await fetchAgreementRow(agreementId);
        expect(finalAgreement.status).toBe("mutually_canceled");
        expect((await fetchVersionRow(versionId)).creditorSignedAt).toBeNull();
        expect(await signatureEventsForVersion(versionId)).toHaveLength(1); // only the pre-existing debtor signature.
      } finally {
        await isolatedSign.close();
        await isolatedCancel.close();
      }
    });
  });

  it("R05 (Codex finding F): a version belonging to a DIFFERENT agreement is rejected even when currentVersionId happens to point at it", async () => {
    const { versionId: versionIdA } = await buildAgreementAtAwaitingSignatures();
    const { agreementId: agreementIdB } = await buildAgreementAtAwaitingSignatures();
    // Simulate the exact gap the explicit ownership check exists to close: agreementB's
    // currentVersionId pointer matches versionIdA (which does NOT belong to it) — a bug/corruption
    // scenario the pointer-equality check alone could never detect.
    await getDb().update(agreement).set({ currentVersionId: versionIdA }).where(eq(agreement.id, agreementIdB));

    const signing = new DrizzleSigningApplicationRepository();
    await expect(
      signing.applySigningAtomically({
        agreementId: agreementIdB,
        agreementVersionId: versionIdA,
        role: "debtor",
        originatorRole: "creditor",
        signedAt: new Date(),
        evidence: evidenceFor(debtorUserId, debtorProfileId, "debtor"),
      }),
    ).rejects.toThrow(ConflictError);

    expect(await signatureEventsForVersion(versionIdA)).toHaveLength(0);
  });

  it("R05-D: required counterparty-first signing order is enforced, and both legitimate signatures still complete normally", async () => {
    const { agreementId, versionId } = await buildAgreementAtAwaitingSignatures();

    // Originator (creditor) attempting to sign first is rejected.
    await expect(
      agreementService.signAgreementWithEvidence(agreementId, creditorUserId, evidenceFor(creditorUserId, creditorProfileId, "creditor")),
    ).rejects.toThrow(CounterpartyMustSignFirstError);
    expect((await fetchVersionRow(versionId)).creditorSignedAt).toBeNull();

    // Counterparty (debtor) signs first — succeeds, agreement not yet fully executed.
    const debtorResult = await agreementService.signAgreementWithEvidence(
      agreementId,
      debtorUserId,
      evidenceFor(debtorUserId, debtorProfileId, "debtor"),
    );
    expect(debtorResult.bothSigned).toBe(false);
    expect(debtorResult.agreementHashAtSigning).toBeTruthy();
    expect((await fetchAgreementRow(agreementId)).status).toBe("awaiting_signatures");

    // Originator (creditor) signs last — completes the agreement.
    const creditorResult = await agreementService.signAgreementWithEvidence(
      agreementId,
      creditorUserId,
      evidenceFor(creditorUserId, creditorProfileId, "creditor"),
    );
    expect(creditorResult.bothSigned).toBe(true);
    expect(creditorResult.agreementHashAtSigning).toBeTruthy();
    expect((await fetchAgreementRow(agreementId)).status).toBe("first_payment_pending");

    const finalVersion = await fetchVersionRow(versionId);
    expect(finalVersion.signedAt).not.toBeNull();
    expect(finalVersion.documentHash).toBe(
      computeVersionHash({ agreementId, versionNumber: finalVersion.versionNumber, terms: finalVersion.terms as AgreementTerms }),
    );

    const events = await signatureEventsForVersion(versionId);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.agreementHashAtSigning).toBe(finalVersion.documentHash); // recorded against the authoritative, transaction-locked version — never a stale pre-transaction one.
    }
  });
});
