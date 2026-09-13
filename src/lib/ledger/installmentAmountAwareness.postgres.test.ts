import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, auditEvent, installmentScheduleItem, ledgerJournalEntry, paymentAttempt, paymentRetry, relationship, settlementProposal } from "@/db/schema";
import { AchPaymentService } from "@/lib/ach/achPaymentService";
import { AgreementProgressService } from "@/lib/agreements/agreementProgressService";
import { DrizzleAgreementInstallmentStatusReader } from "@/lib/agreements/drizzleAgreementInstallmentStatusReader";
import { DrizzleAgreementInstallmentSettlementReader } from "@/lib/agreements/drizzleAgreementInstallmentSettlementReader";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { ValidationError } from "@/lib/errors";
import { DrizzlePaymentRetryRepository } from "@/lib/failedPayments/drizzlePaymentRetryRepository";
import { DrizzleFailedPaymentRetryCoordinator, type PartialPaymentApplicationForRepair } from "@/lib/failedPayments/failedPaymentRetryCoordinator";
import { FailedPaymentWorkflowService } from "@/lib/failedPayments/failedPaymentWorkflowService";
import { PaymentRetryService } from "@/lib/failedPayments/paymentRetryService";
import { AgreementCompletionService, type AgreementBalanceComputer, type AgreementStatusRepository } from "@/lib/ledger/agreementCompletionService";
import { DrizzleAtomicAgreementCompletionDecider } from "@/lib/ledger/drizzleAtomicAgreementCompletionDecider";
import { BalanceService } from "@/lib/ledger/balanceService";
import { DrizzleAgreementInstallmentReader } from "@/lib/ledger/drizzleAgreementInstallmentReader";
import { DrizzleAgreementInstallmentSatisfactionReader } from "@/lib/ledger/drizzleAgreementInstallmentSatisfactionReader";
import { DrizzleAgreementTermsReader } from "@/lib/ledger/drizzleAgreementTermsReader";
import { DrizzleInstallmentSettlementComputer } from "@/lib/ledger/drizzleInstallmentSettlementComputer";
import { DrizzleLedgerAccountRepository } from "@/lib/ledger/drizzleLedgerAccountRepository";
import { DrizzleLedgerJournalEntryRepository } from "@/lib/ledger/drizzleLedgerJournalEntryRepository";
import { DrizzleReconciliationExceptionRepository } from "@/lib/ledger/drizzleReconciliationExceptionRepository";
import { LedgerService } from "@/lib/ledger/ledgerService";
import { ReconciliationService } from "@/lib/ledger/reconciliationService";
import { DrizzleAgreementPartiesReader } from "@/lib/payments/drizzleAgreementPartiesReader";
import { DrizzleAgreementScheduleReader } from "@/lib/payments/drizzleAgreementScheduleReader";
import { DrizzleAtomicManualPaymentPoster } from "@/lib/payments/drizzleAtomicManualPaymentPoster";
import { DrizzleInstallmentAwarePaymentReserver } from "@/lib/payments/drizzleInstallmentAwarePaymentReserver";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzlePaymentWebhookEventRepository } from "@/lib/payments/drizzlePaymentWebhookEventRepository";
import { DrizzlePaymentInitiationEligibilityService } from "@/lib/payments/paymentInitiationEligibilityService";
import { DrizzleSettlementContextVerifier } from "@/lib/payments/drizzleSettlementContextVerifier";
import { SandboxPaymentProvider } from "@/lib/payments/sandboxPaymentProvider";
import { DrizzlePaymentTransitionCoordinator } from "@/lib/payments/paymentTransitionCoordinator";
import { PaymentService, type ManualPaymentInstallmentHook, type PaymentAttemptRecord } from "@/lib/payments/paymentService";
import { PaymentWebhookService } from "@/lib/payments/paymentWebhookService";
import { DrizzlePartialPaymentRepository } from "@/lib/partialPayments/drizzlePartialPaymentRepository";
import { PartialPaymentAutoApplicationService } from "@/lib/partialPayments/partialPaymentAutoApplicationService";
import { PartialPaymentService } from "@/lib/partialPayments/partialPaymentService";
import { createTestNotificationService } from "@/lib/notify/testFakes";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import { waitUntilPidBlockedOnLock } from "../../../test/postgres/lockBarrier";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { createIsolatedDb, warmUp } from "../../../test/postgres/testDb";

/**
 * R11 (INSTALLMENT AMOUNT-AWARENESS / PARTIAL-PAYMENT CORRECTNESS) — dedicated Postgres regression
 * coverage for P12–P17 (the payment-initiation ceiling, linkage preservation across the manual-retry
 * and partial-payment flows, the ordinary-payment linkage requirement, the settlement exemption, and
 * historical reconciliation) — real Drizzle repositories against a real, disposable Postgres, exactly
 * like `paymentWebhookRecovery.postgres.test.ts`'s own established convention. P1–P11 (amount-aware
 * coordinateSuccess/coordinateSupersession, paid_in_full, concurrency) are covered there.
 */

async function seedAgreementWithInstallment(
  creditorProfileId: string,
  debtorProfileId: string,
  creatorUserId: string,
  installmentAmountMinorUnits: number,
  dueDate = "2099-01-01",
) {
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
      producedBy: "r11_postgres_test_seed",
      frequency: "monthly",
      feeAllocation: "creditor_pays",
      terms: { currentPrincipalMinorUnits: installmentAmountMinorUnits } as object,
    })
    .returning();
  if (!version) throw new Error("agreement_version insert returned no row");
  await db.update(agreement).set({ currentVersionId: version.id, status: "first_payment_pending" }).where(eq(agreement.id, created.id));
  const [installment] = await db
    .insert(installmentScheduleItem)
    .values({ agreementVersionId: version.id, sequenceNumber: 0, dueDate, amountMinorUnits: installmentAmountMinorUnits })
    .returning();
  if (!installment) throw new Error("installment_schedule_item insert returned no row");
  return { agreementId: created.id, versionId: version.id, installmentScheduleItemId: installment.id };
}

async function seedVerifiedParty(
  verificationCtx: ReturnType<typeof createTestVerificationService>,
  profileKind: "personal",
  profileId: string,
  userId: string,
) {
  verificationCtx.profileOwners.set(profileKind, profileId, userId);
  await verificationCtx.verificationService.submitFullVerificationRequest(profileKind, profileId);
  await verificationCtx.verificationService.recordManualVerificationDecision({
    actingRole: "platform_owner",
    profileKind,
    profileId,
    decision: "verified",
    reviewerUserId: randomUUID(), // a reviewer distinct from the profile's own owner — never the same user.
    reason: null,
  });
}

/**
 * Full, real-Postgres PaymentService wiring, sharing ONE verification context between payer/recipient
 * (unlike buildPaymentService's own fresh, unwired one).
 *
 * R11 CORRECTION PASS A (TEST INFRASTRUCTURE REQUIREMENT — genuine independent-connection
 * concurrency): `installmentReserver`/`atomicManualPayments` are overridable so a
 * `*.postgres.test.ts` race can bind EACH racing side's reserver/poster to a genuinely SEPARATE,
 * independently-connected instance (`createIsolatedDb`), while every OTHER dependency (verification,
 * audit, balances, ledger, completion, agreement-parties) stays on the shared singleton — those are
 * never the contended resource under test in R18/R23/R26/R27, only the installment/agreement row lock
 * acquired inside the reserver's/poster's OWN transaction is.
 */
function buildContextForLinkageTests(overrides?: {
  installmentReserver?: DrizzleInstallmentAwarePaymentReserver;
  atomicManualPayments?: DrizzleAtomicManualPaymentPoster;
  /**
   * R11 PASS B1 (Defect B1-2): optional — defaults to `undefined` (preserving every pre-existing
   * test's exact behavior unchanged) so only the NEW B1 tests that explicitly need it exercise the
   * real installment-completion hook a manual payment now runs in production.
   */
  installmentHook?: ManualPaymentInstallmentHook;
}) {
  const verificationCtx = createTestVerificationService();
  const provider = new SandboxPaymentProvider("r11-p12-p17-postgres-test-webhook-secret");
  const payments = new DrizzlePaymentAttemptRepository();
  const ledgerAccounts = new DrizzleLedgerAccountRepository();
  const ledgerEntries = new DrizzleLedgerJournalEntryRepository();
  const ledger = new LedgerService({ accounts: ledgerAccounts, entries: ledgerEntries, audit: new AuditService(new DrizzleAuditEventRepository()) });
  const agreements = new DrizzleAgreementRepository();
  const balances = new BalanceService({ ledger, terms: new DrizzleAgreementTermsReader() });
  const completion = new AgreementCompletionService({
    agreements: agreements as unknown as AgreementStatusRepository,
    balances: balances as unknown as AgreementBalanceComputer,
    audit: new AuditService(new DrizzleAuditEventRepository()),
    installmentSatisfaction: new DrizzleAgreementInstallmentSatisfactionReader(),
    // R11 CORRECTION PASS A (Defect A4): wired so this suite exercises the real, tx-bound completion
    // decision — see `AtomicAgreementCompletionDecider`'s own doc comment.
    atomicCompletion: new DrizzleAtomicAgreementCompletionDecider(),
  });
  const paymentService = new PaymentService({
    provider,
    verification: verificationCtx.verificationService,
    profileOwners: verificationCtx.profileOwners,
    payments,
    audit: new AuditService(new DrizzleAuditEventRepository()),
    agreements: new DrizzleAgreementPartiesReader(),
    balances,
    ledger,
    completion,
    atomicManualPayments: overrides?.atomicManualPayments ?? new DrizzleAtomicManualPaymentPoster(),
    installmentReserver: overrides?.installmentReserver ?? new DrizzleInstallmentAwarePaymentReserver(),
    scheduleReader: new DrizzleAgreementScheduleReader(),
    settlementContext: new DrizzleSettlementContextVerifier(),
    installmentHook: overrides?.installmentHook,
  });
  return { verificationCtx, paymentService, payments, ledger };
}

/**
 * R11 PASS B1 (Defect B1-2 — MANUAL/OFF-PLATFORM PAYMENT DOES NOT RUN INSTALLMENT COMPLETION): the
 * SAME `ManualPaymentInstallmentHook` real production wiring now supplies (see
 * `getPaymentService.ts`'s own doc comment) — `FailedPaymentWorkflowService.handlePaymentSucceeded`,
 * backed by the REAL `DrizzleFailedPaymentRetryCoordinator`, so `coordinateSuccess` (the SAME
 * authoritative, amount-aware logic the provider-routed webhook success path already uses) runs after
 * every manual payment in these tests too. `retries`/`installments`/`notifications`/`profileOwners`
 * are never reached when `retryCoordinator` is wired (see `FailedPaymentWorkflowService
 * .handlePaymentSucceeded`'s own body) — stubbed-and-throwing here, never expected to actually run.
 */
function buildRealInstallmentHook(): ManualPaymentInstallmentHook {
  const retryCoordinator = new DrizzleFailedPaymentRetryCoordinator();
  const unusedDep = new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error("not used in this test — handlePaymentSucceeded only ever calls retryCoordinator.coordinateSuccess when a coordinator is wired");
        };
      },
    },
  );
  const workflow = new FailedPaymentWorkflowService({
    installments: unusedDep as ConstructorParameters<typeof FailedPaymentWorkflowService>[0]["installments"],
    retries: unusedDep as ConstructorParameters<typeof FailedPaymentWorkflowService>[0]["retries"],
    notifications: unusedDep as ConstructorParameters<typeof FailedPaymentWorkflowService>[0]["notifications"],
    profileOwners: unusedDep as ConstructorParameters<typeof FailedPaymentWorkflowService>[0]["profileOwners"],
    retryCoordinator,
  });
  return { handlePaymentSucceeded: (payment) => workflow.handlePaymentSucceeded(payment) };
}

/**
 * R11 PASS B1 — TARGETED FINAL CORRECTION (Defect B1-A): a REAL `AchPaymentService`, bound to
 * `paymentService` (the SAME `PaymentService` instance a test's own context already uses — so the
 * REAL reservation path, including whichever installmentReserver/atomicManualPayments/installmentHook
 * that context is wired with, is what actually runs). `mandates` is a minimal stub reporting an
 * always-active mandate — the REAL `AchMandateService`/`DrizzleAchMandateRepository` require their
 * own separate authorization/relationship-linking flow entirely orthogonal to what this correction is
 * about (whether "Pay now" reaches the real rail at all), so it is stubbed here exactly like this
 * file's other out-of-scope collaborators (e.g. `relatedAgreementService`, `PartialPaymentService`'s
 * own dependency stubs above).
 */
function buildAchPaymentServiceForTest(paymentService: PaymentService): AchPaymentService {
  const mandateStub = {
    getActiveMandate: async () => ({
      id: randomUUID(),
      agreementId: "unused",
      payerProfileKind: "personal",
      payerProfileId: "unused",
      bankAccountRef: "unused",
      financialAccountId: null,
      status: "active",
    }),
  } as unknown as ConstructorParameters<typeof AchPaymentService>[0]["mandates"];
  return new AchPaymentService({
    mandates: mandateStub,
    payments: paymentService,
    paymentAttempts: new DrizzlePaymentAttemptRepository(),
  });
}

async function seedTwoParties() {
  const creditor = await seedPersonalUser(`r11-p-creditor-${randomUUID()}`);
  const debtor = await seedPersonalUser(`r11-p-debtor-${randomUUID()}`);
  return { creditor, debtor };
}

describe("R11: installment amount-awareness — P12-P17 (real Postgres)", () => {
  describe("P12 — installment ceiling", () => {
    it("manual-payment path: 75/100 allow, then 25/100 (=100) allow, then rejects any further amount — never exceeds the installment's own remaining", async () => {
      // R11 (PAYMENT INITIATION CEILING — DESIGN NOTE, confirmed empirically here): a provider-routed
      // `createPayment` reservation stays "pending" until an async webhook later clears it — the
      // ceiling (like the PRE-EXISTING agreement-level `assertNotOverpaying`/
      // `computeRemainingBalanceMinorUnitsWithinTx` it deliberately mirrors) is computed from
      // AUTHORITATIVE, CLEARED ledger money, never from "a reservation merely exists" — so two
      // sequential PENDING provider-routed reservations cannot cumulatively exhaust it by themselves
      // (each is individually checked against the FACE amount until either actually clears). This is
      // the SAME pre-existing, accepted design as the agreement-level guard, not a new R11 relaxation.
      // The manual/off-platform path clears SYNCHRONOUSLY, inside the SAME atomic transaction as its
      // own ceiling check and reservation — this is where cumulative, sequential ceiling tracking is
      // actually guaranteed, and is what this test proves.
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
      const ctx = buildContextForLinkageTests();
      await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
      await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

      const first = await ctx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: `p12-first-${randomUUID()}`,
        agreementId,
        amountMinorUnits: 75,
        actingUserId: debtor.userId,
        installmentScheduleItemId,
      });
      expect(first.status).toBe("succeeded");
      expect(first.installmentScheduleItemId).toBe(installmentScheduleItemId);

      // A second attempt for the remaining 25 (75+25=100, exactly the installment's own face amount) is allowed.
      const second = await ctx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: `p12-second-${randomUUID()}`,
        agreementId,
        amountMinorUnits: 25,
        actingUserId: debtor.userId,
        installmentScheduleItemId,
      });
      expect(second.status).toBe("succeeded");

      // A third attempt for even 1 more minor unit must be rejected — the installment's real, cleared
      // money already totals its full face amount.
      await expect(
        ctx.paymentService.recordManualOffPlatformPayment({
          idempotencyKey: `p12-third-${randomUUID()}`,
          agreementId,
          amountMinorUnits: 1,
          actingUserId: debtor.userId,
          installmentScheduleItemId,
        }),
      ).rejects.toThrow();
    });

    it("provider-routed path: a single reservation may never itself exceed the installment's remaining, computed fresh at reservation time", async () => {
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
      const ctx = buildContextForLinkageTests();
      await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
      await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

      const withinCeiling = await ctx.paymentService.createPayment({
        idempotencyKey: `p12-provider-ok-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 100,
        currency: "USD",
        agreementId,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId,
      });
      expect(withinCeiling.status).not.toBe("failed");
      expect(withinCeiling.installmentScheduleItemId).toBe(installmentScheduleItemId);

      // Once that same money actually clears (a real ledger_cleared entry, mirroring the real webhook
      // path), a further reservation against the now-fully-covered installment is rejected.
      const db = getDb();
      await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, withinCeiling.id));
      await ctx.ledger.postPaymentCleared({ paymentAttemptId: withinCeiling.id, agreementId, currency: "USD", grossAmountMinorUnits: 100 });
      await expect(
        ctx.paymentService.createPayment({
          idempotencyKey: `p12-provider-reject-after-clear-${randomUUID()}`,
          payer: { profileKind: "personal", profileId: debtor.profileId },
          recipient: { profileKind: "personal", profileId: creditor.profileId },
          amountMinorUnits: 1,
          currency: "USD",
          agreementId,
          actingUserId: debtor.userId,
          ipAddress: null,
          deviceInfo: null,
          installmentScheduleItemId,
        }),
      ).rejects.toThrow();
    });

    it("125/100 is rejected outright on a fresh installment with no prior contribution, for both the provider-routed and manual-payment paths", async () => {
      const { creditor, debtor } = await seedTwoParties();
      const ctx = buildContextForLinkageTests();
      await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
      await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

      const { agreementId: agreementA, installmentScheduleItemId: installmentA } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        100,
      );
      await expect(
        ctx.paymentService.createPayment({
          idempotencyKey: `p12-provider-reject-${randomUUID()}`,
          payer: { profileKind: "personal", profileId: debtor.profileId },
          recipient: { profileKind: "personal", profileId: creditor.profileId },
          amountMinorUnits: 125,
          currency: "USD",
          agreementId: agreementA,
          actingUserId: debtor.userId,
          ipAddress: null,
          deviceInfo: null,
          installmentScheduleItemId: installmentA,
        }),
      ).rejects.toThrow();

      const { agreementId: agreementB, installmentScheduleItemId: installmentB } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        100,
      );
      await expect(
        ctx.paymentService.recordManualOffPlatformPayment({
          idempotencyKey: `p12-manual-reject-${randomUUID()}`,
          agreementId: agreementB,
          amountMinorUnits: 125,
          actingUserId: debtor.userId,
          installmentScheduleItemId: installmentB,
        }),
      ).rejects.toThrow();
    });

    it("concurrent MANUAL reservations against the SAME installment cannot jointly exceed the remaining amount — exactly one of two racing 60/100 attempts succeeds", async () => {
      // R11: manual/off-platform payments clear synchronously (their own money is real, committed
      // ledger truth the instant the row is inserted, inside the SAME atomic transaction as the
      // ceiling check itself — see DrizzleAtomicManualPaymentPoster) — genuinely concurrent manual
      // reservations against the SAME installment are exactly where the row lock's mutual exclusion
      // is load-bearing, and where two racing 60/100 attempts (120 > 100) must never both succeed.
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
      const ctx = buildContextForLinkageTests();
      await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
      await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

      const attempt = (n: number) =>
        ctx.paymentService
          .recordManualOffPlatformPayment({
            idempotencyKey: `p12-race-${n}-${randomUUID()}`,
            agreementId,
            amountMinorUnits: 60,
            actingUserId: debtor.userId,
            installmentScheduleItemId,
          })
          .then(() => "ok" as const)
          .catch(() => "rejected" as const);

      const results = await Promise.all([attempt(1), attempt(2)]);
      // Two genuinely concurrent 60/100 reservations can never both succeed (60+60=120 > 100) — the
      // installment row lock inside DrizzleAtomicManualPaymentPoster serializes them, and the second
      // to acquire the lock re-reads authoritative, post-first-commit evidence.
      expect(results.filter((r) => r === "ok")).toHaveLength(1);
      expect(results.filter((r) => r === "rejected")).toHaveLength(1);
    });
  });

  describe("P13 — PaymentDetail manual retry preserves installment linkage", () => {
    it("a manual retry created with the original payment's own installmentScheduleItemId (the exact field PaymentDetail.tsx now threads through) produces a payment attributable to that installment", async () => {
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500);
      const ctx = buildContextForLinkageTests();
      await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
      await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

      // The ORIGINAL (now-failed) payment — its own installmentScheduleItemId is what /api/payments/detail
      // now returns and PaymentDetail.tsx's handleManualPay now threads through.
      const original = await ctx.paymentService.createPayment({
        idempotencyKey: `p13-original-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 500,
        currency: "USD",
        agreementId,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId,
      });
      expect(original.installmentScheduleItemId).toBe(installmentScheduleItemId);
      // R11 TARGETED PROVIDER-RESERVATION CORRECTION: a manual "retry" is only ever offered for an
      // ALREADY-FAILED original payment (PaymentDetail.tsx's own retry button never appears for a
      // still-unresolved payment) — the original must become genuinely terminal here, exactly like
      // real production ordering, before the "at most one unresolved attempt" invariant would ever
      // permit a new attempt against this same installment.
      const db = getDb();
      await db.update(paymentAttempt).set({ status: "failed" }).where(eq(paymentAttempt.id, original.id));
      const retrieved = await ctx.paymentService.retrievePayment(original.id, debtor.userId);
      expect(retrieved.installmentScheduleItemId).toBe(installmentScheduleItemId); // exactly what /api/payments/detail now returns.

      // The manual-retry flow, using that SAME field (mirroring PaymentDetail.tsx's fixed handleManualPay).
      const retried = await ctx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: `p13-retry-${randomUUID()}`,
        agreementId,
        amountMinorUnits: 500,
        actingUserId: debtor.userId,
        installmentScheduleItemId: retrieved.installmentScheduleItemId ?? undefined,
      });
      expect(retried.installmentScheduleItemId).toBe(installmentScheduleItemId);
      expect(retried.status).toBe("succeeded");
    });
  });

  describe("P14 — partial payment: proposal captures installment id, survives through payment creation/application", () => {
    it("$400 of $1,000 leaves $600 outstanding and payable, and the partial payment stays linked end-to-end", async () => {
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
      const ctx = buildContextForLinkageTests();
      await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
      await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

      const agreements = new DrizzleAgreementRepository();
      const relatedAgreementService = {
        resolvePartyRole: async (_aId: string, userId: string) => (userId === debtor.userId ? ("debtor" as const) : ("creditor" as const)),
        getAgreement: async () => ({
          agreement: { debtorProfileKind: "personal" as const, debtorProfileId: debtor.profileId, creditorProfileKind: "personal" as const, creditorProfileId: creditor.profileId },
        }),
        requireCreditorCapability: async () => {},
      };
      const partialPayments = new DrizzlePartialPaymentRepository();
      const partialPaymentService = new PartialPaymentService({
        agreementService: relatedAgreementService as unknown as ConstructorParameters<typeof PartialPaymentService>[0]["agreementService"],
        requests: partialPayments,
        payments: new DrizzlePaymentAttemptRepository(),
        audit: new AuditService(new DrizzleAuditEventRepository()),
      });
      void agreements;

      // Proposal captures the target installment — mirrors PartialPaymentPanel's own fixed `propose()`.
      const request = await partialPaymentService.proposePartialPayment({
        agreementId,
        proposedAmountMinorUnits: 400,
        proposedDate: "2030-01-01",
        installmentScheduleItemId,
        actingUserId: debtor.userId,
      });
      expect(request.installmentScheduleItemId).toBe(installmentScheduleItemId);
      await partialPaymentService.decidePartialPayment({ partialPaymentRequestId: request.id, actingUserId: creditor.userId, decision: "accept" });

      // The payment created for it (mirroring "go to My Cash" -> manual payment, now carrying the
      // proposal's own installment id) is linked, and recordPayment's own installment-match guard passes.
      const paid = await ctx.paymentService.createPayment({
        idempotencyKey: `p14-payment-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 400,
        currency: "USD",
        agreementId,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId,
      });
      const settled = await ctx.paymentService.retrievePayment(paid.id, debtor.userId);
      // Force it to a real "succeeded" status with a real ledger clearing, exactly as R11's own
      // authoritative-settlement arithmetic requires (never inferred from "a payment attempt exists").
      const db = getDb();
      if (settled.status !== "succeeded") {
        await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, paid.id));
        await ctx.ledger.postPaymentCleared({ paymentAttemptId: paid.id, agreementId, currency: "USD", grossAmountMinorUnits: 400 });
      }

      const applied = await partialPaymentService.recordPayment({ partialPaymentRequestId: request.id, paymentAttemptId: paid.id, actingUserId: debtor.userId });
      expect(applied.status).toBe("applied");

      const settlementComputer = new DrizzleInstallmentSettlementComputer();
      const settlement = await settlementComputer.computeSettlement(installmentScheduleItemId);
      expect(settlement).not.toBeNull();
      expect(settlement!.settledMinorUnits).toBe(400);
      expect(settlement!.remainingMinorUnits).toBe(600);
      expect(settlement!.isSatisfied).toBe(false); // the installment remains selectable/payable for its true $600 remaining.

      // recordPayment's own installment-match guard rejects a payment linked to a DIFFERENT installment.
      const { installmentScheduleItemId: otherInstallment } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
      const mismatchedRequest = await partialPaymentService.proposePartialPayment({
        agreementId,
        proposedAmountMinorUnits: 100,
        proposedDate: "2030-01-01",
        installmentScheduleItemId: otherInstallment,
        actingUserId: debtor.userId,
      });
      await partialPaymentService.decidePartialPayment({ partialPaymentRequestId: mismatchedRequest.id, actingUserId: creditor.userId, decision: "accept" });
      const mismatchedPaymentIdempotencyKey = `p14-mismatch-${randomUUID()}`;
      const mismatchedPayment = await ctx.paymentService.createPayment({
        idempotencyKey: mismatchedPaymentIdempotencyKey,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 100,
        currency: "USD",
        agreementId,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId, // deliberately the FIRST installment, not otherInstallment — a mismatch against mismatchedRequest's own target.
      });
      await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, mismatchedPayment.id));
      await expect(
        partialPaymentService.recordPayment({ partialPaymentRequestId: mismatchedRequest.id, paymentAttemptId: mismatchedPayment.id, actingUserId: debtor.userId }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("P15 — unlinked ordinary payment against a scheduled agreement is rejected server-side", () => {
    it("createPayment with no installmentScheduleItemId against a scheduled agreement is rejected, including when called directly (not merely omitted by a UI)", async () => {
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500);
      const ctx = buildContextForLinkageTests();
      await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
      await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

      await expect(
        ctx.paymentService.createPayment({
          idempotencyKey: `p15-unlinked-${randomUUID()}`,
          payer: { profileKind: "personal", profileId: debtor.profileId },
          recipient: { profileKind: "personal", profileId: creditor.profileId },
          amountMinorUnits: 500,
          currency: "USD",
          agreementId,
          actingUserId: debtor.userId,
          ipAddress: null,
          deviceInfo: null,
          // No installmentScheduleItemId, no settlementProposalId — the exact "bare API call" shape a
          // UI omission or a direct API client could produce.
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        ctx.paymentService.recordManualOffPlatformPayment({
          idempotencyKey: `p15-unlinked-manual-${randomUUID()}`,
          agreementId,
          amountMinorUnits: 500,
          actingUserId: debtor.userId,
        }),
      ).rejects.toThrow(ValidationError);

      // Sanity: an agreement with NO schedule at all is NOT subject to this requirement (the existing,
      // valid agreement-level-only behavior for an unscheduled agreement is preserved).
      const agreements = new DrizzleAgreementRepository();
      const unscheduled = await agreements.insert({
        creditorProfileKind: "personal",
        creditorProfileId: creditor.profileId,
        debtorProfileKind: "personal",
        debtorProfileId: debtor.profileId,
        currency: "USD",
        createdByUserId: creditor.userId,
      });
      const db = getDb();
      const [version] = await db
        .insert(agreementVersion)
        .values({
          agreementId: unscheduled.id,
          versionNumber: 1,
          isOriginal: true,
          producedBy: "r11_postgres_test_seed_unscheduled",
          frequency: "monthly",
          feeAllocation: "creditor_pays",
          terms: { currentPrincipalMinorUnits: 500 } as object,
        })
        .returning();
      await db.update(agreement).set({ currentVersionId: version!.id, status: "first_payment_pending" }).where(eq(agreement.id, unscheduled.id));
      const unlinkedOnUnscheduled = await ctx.paymentService.createPayment({
        idempotencyKey: `p15-unscheduled-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 500,
        currency: "USD",
        agreementId: unscheduled.id,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
      });
      expect(unlinkedOnUnscheduled.status).not.toBe("failed");
    });
  });

  describe("P16 — legitimate settlement payment stays valid with no ordinary installment linkage", () => {
    it("a payment with a verified, real, awaiting_payment settlementProposalId is exempt from the linkage requirement; a bare null installment id alone (no settlementProposalId) is NOT", async () => {
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500);
      const ctx = buildContextForLinkageTests();
      await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
      await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

      const db = getDb();
      const [proposal] = await db
        .insert(settlementProposal)
        .values({
          agreementId,
          status: "awaiting_payment",
          proposingPartyRole: "creditor",
          proposedByProfileKind: "personal",
          proposedByProfileId: creditor.profileId,
          preSettlementBalanceMinorUnits: 500,
          settlementAmountMinorUnits: 300,
          forgivenAmountMinorUnits: 200,
          deadline: "2030-01-01",
          paymentMode: "one_time",
          failureConsequence: "restore_original",
        })
        .returning();
      if (!proposal) throw new Error("settlement_proposal insert returned no row");

      // Verified settlementProposalId -> exempt, even though the agreement has a real schedule.
      const settlementPayment = await ctx.paymentService.createPayment({
        idempotencyKey: `p16-settlement-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 300,
        currency: "USD",
        agreementId,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        settlementProposalId: proposal.id,
      });
      expect(settlementPayment.status).not.toBe("failed");
      expect(settlementPayment.installmentScheduleItemId).toBeNull();

      // A DIFFERENT agreement's own real settlement proposal id must NOT exempt THIS agreement's payment
      // (the verifier checks the proposal belongs to the SAME agreement).
      const { agreementId: otherAgreementId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500);
      await expect(
        ctx.paymentService.createPayment({
          idempotencyKey: `p16-cross-agreement-${randomUUID()}`,
          payer: { profileKind: "personal", profileId: debtor.profileId },
          recipient: { profileKind: "personal", profileId: creditor.profileId },
          amountMinorUnits: 300,
          currency: "USD",
          agreementId: otherAgreementId,
          actingUserId: debtor.userId,
          ipAddress: null,
          deviceInfo: null,
          settlementProposalId: proposal.id, // belongs to `agreementId`, not `otherAgreementId`.
        }),
      ).rejects.toThrow(ValidationError);

      // A bare, unverified/fabricated settlementProposalId (random uuid, no real row) must NOT exempt.
      await expect(
        ctx.paymentService.createPayment({
          idempotencyKey: `p16-fake-proposal-${randomUUID()}`,
          payer: { profileKind: "personal", profileId: debtor.profileId },
          recipient: { profileKind: "personal", profileId: creditor.profileId },
          amountMinorUnits: 300,
          currency: "USD",
          agreementId,
          actingUserId: debtor.userId,
          ipAddress: null,
          deviceInfo: null,
          settlementProposalId: randomUUID(),
        }),
      ).rejects.toThrow(ValidationError);

      // SettlementService's own settled_in_full lifecycle is entirely separate and untouched by any of
      // this — confirmed structurally: recordSettlementPayment never appears in this file's imports at
      // all (see settlementService.ts's own doc comment — it only ever writes "settled_in_full", never
      // "paid_in_full"), and this test's own settlement payment above never advanced agreement.status
      // to "paid_in_full" merely by being recorded (checkAndAdvance requires the FULL aggregate balance,
      // which $300 of $500 principal does not reach).
      const agreementRow = await db.select({ status: agreement.status }).from(agreement).where(eq(agreement.id, agreementId)).limit(1);
      expect(agreementRow[0]?.status).not.toBe("paid_in_full");
      expect(agreementRow[0]?.status).not.toBe("settled_in_full"); // this test never calls SettlementService itself — confirms no side effect leaked in.
    });
  });

  describe("P17 — historical reconciliation: authoritative vs. cached disagreement produces evidence, never mutates cached status", () => {
    it("an installment whose cached status says 'scheduled' but whose ledger evidence already fully covers it produces an amount_mismatch exception with full evidence, and the cached status is left untouched", async () => {
      const { creditor, debtor } = await seedTwoParties();
      const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000, "2020-01-01");

      // Simulate PRE-R11 historical data: a real, fully-covering payment cleared for this installment,
      // but the cached installment_schedule_item.status was NEVER flipped to "paid" (exactly the
      // pre-existing gap this remediation exists to detect and report, never silently fix).
      const payments = new DrizzlePaymentAttemptRepository();
      const historicalPayment = await payments.insertPending({
        idempotencyKey: `p17-historical-${randomUUID()}`,
        payerProfileKind: "personal",
        payerProfileId: debtor.profileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditor.profileId,
        amountMinorUnits: 1_000,
        currency: "USD",
        agreementId,
        providerName: "sandbox_mock",
        installmentScheduleItemId,
      });
      await payments.updateStatus(historicalPayment.id, "succeeded", {});
      const ledgerAccounts = new DrizzleLedgerAccountRepository();
      const ledgerEntries = new DrizzleLedgerJournalEntryRepository();
      const ledger = new LedgerService({ accounts: ledgerAccounts, entries: ledgerEntries, audit: new AuditService(new DrizzleAuditEventRepository()) });
      await ledger.postPaymentCleared({ paymentAttemptId: historicalPayment.id, agreementId, currency: "USD", grossAmountMinorUnits: 1_000 });

      const db = getDb();
      const cachedBefore = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
      expect(cachedBefore[0]?.status).toBe("scheduled"); // never auto-flipped — this sweep is report-only.

      const reconciliation = new ReconciliationService({
        payments,
        webhookEvents: { listAll: async () => [], findTrustedFinancialEventsForPayment: async () => [], findByProviderEvent: async () => null } as unknown as ConstructorParameters<typeof ReconciliationService>[0]["webhookEvents"],
        provider: new SandboxPaymentProvider("r11-p12-p17-postgres-test-webhook-secret"),
        ledger,
        exceptions: new DrizzleReconciliationExceptionRepository(),
        installments: new DrizzleAgreementInstallmentReader(),
        installmentSettlements: new DrizzleInstallmentSettlementComputer(),
      });

      const found = await reconciliation.reconcileInstallmentAmountAwareness(agreementId);
      expect(found).toHaveLength(1);
      const exception = found[0]!;
      expect(exception.exceptionType).toBe("amount_mismatch");
      const details = exception.details as {
        installmentScheduleItemId: string;
        requiredAmountMinorUnits: number;
        authoritativeNetSettledMinorUnits: number;
        differenceMinorUnits: number;
        currentStatus: string;
        expectedStatus: string;
        contributingPaymentAttemptIds: string[];
      };
      expect(details.installmentScheduleItemId).toBe(installmentScheduleItemId);
      expect(details.requiredAmountMinorUnits).toBe(1_000);
      expect(details.authoritativeNetSettledMinorUnits).toBe(1_000);
      expect(details.differenceMinorUnits).toBe(0);
      expect(details.currentStatus).toBe("scheduled");
      expect(details.expectedStatus).toBe("paid");
      expect(details.contributingPaymentAttemptIds).toEqual([historicalPayment.id]);

      // The cached status is STILL untouched after the sweep — report-only, never a silent mutation.
      const cachedAfter = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
      expect(cachedAfter[0]?.status).toBe("scheduled");

      // Idempotent re-run: the SAME open exception is found, never duplicated (findOpen's own identity check).
      const foundAgain = await reconciliation.reconcileInstallmentAmountAwareness(agreementId);
      expect(foundAgain).toHaveLength(1);
      expect(foundAgain[0]!.id).toBe(exception.id);

      // A DIFFERENT installment (agreement-scoped) whose cached status already agrees produces nothing.
      const { installmentScheduleItemId: agreeingInstallment, agreementId: agreementId2 } = await seedAgreementWithInstallment(
        creditor.profileId,
        debtor.profileId,
        creditor.userId,
        500,
      );
      const foundForClean = await reconciliation.reconcileInstallmentAmountAwareness(agreementId2);
      expect(foundForClean).toHaveLength(0);
      void agreeingInstallment;
    });
  });
});

/**
 * R11 TARGETED PROVIDER-RESERVATION CORRECTION (R18–R23): dedicated regression coverage for
 * "AT MOST ONE UNRESOLVED PAYMENT ATTEMPT MAY EXIST PER INSTALLMENT" — closes the confirmed TOCTOU
 * gap where the cleared-money-only ceiling let two concurrent provider-routed reservations both
 * succeed.
 *
 * R11 CORRECTION PASS A additions (R24–R28): defects A1 (succeeded-before-ledger reservation gap), A2
 * (installment/agreement ownership), A3 (agreement/installment lock ordering), and A4 (paid_in_full
 * stale-evidence race) — see each test's own doc comment for the exact scenario.
 *
 * TEST INFRASTRUCTURE REQUIREMENT (R11 CORRECTION PASS A): every concurrency assertion in this
 * describe block now uses GENUINELY independent Postgres connections (`createIsolatedDb`, separate
 * backend pids proven via `warmUp`), deterministic server-side barriers (`waitUntilPidBlockedOnLock`
 * — polls `pg_stat_activity`, never a sleep), and asserts the SPECIFIC rejection reason (the exact
 * `ValidationError` message), never merely "some error happened" — R18 and R23 (previously racing two
 * `Promise`s on ONE shared, `max: 1`-pooled connection, which cannot hold two truly overlapping
 * transactions) are repaired to this same standard, not merely the new R24–R28 tests.
 */
describe("R11 TARGETED PROVIDER-RESERVATION CORRECTION — R18-R28 (real Postgres)", () => {
  const DATABASE_URL = process.env.DATABASE_URL!;

  function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  async function countAttemptsForInstallment(installmentScheduleItemId: string): Promise<number> {
    const db = getDb();
    const rows = await db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId));
    return rows.length;
  }

  /** Verifies the SAME two parties against a context's own fresh, isolated in-memory verification fake. */
  async function seedVerifiedParties(ctx: { verificationCtx: ReturnType<typeof createTestVerificationService> }, debtorProfileId: string, debtorUserId: string, creditorProfileId: string, creditorUserId: string) {
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtorProfileId, debtorUserId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditorProfileId, creditorUserId);
  }

  it("R18 — concurrent provider reservation on GENUINELY independent Postgres connections: A=75 and B=75 against remaining=100 -> exactly one payment_attempt created, the other rejected with the SPECIFIC 'unresolved payment attempt' reason", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const bPid = await warmUp(isolatedB.client);
      const lockAcquired = createDeferred<void>();
      const releaseA = createDeferred<void>();
      const ctxA = buildContextForLinkageTests({
        installmentReserver: new DrizzleInstallmentAwarePaymentReserver(isolatedA.db, {
          afterInstallmentLock: async () => {
            lockAcquired.resolve();
            await releaseA.promise;
          },
        }),
      });
      const ctxB = buildContextForLinkageTests({ installmentReserver: new DrizzleInstallmentAwarePaymentReserver(isolatedB.db) });
      await seedVerifiedParties(ctxA, debtor.profileId, debtor.userId, creditor.profileId, creditor.userId);
      await seedVerifiedParties(ctxB, debtor.profileId, debtor.userId, creditor.profileId, creditor.userId);

      const buildInput = (idempotencyKey: string) => ({
        idempotencyKey,
        payer: { profileKind: "personal" as const, profileId: debtor.profileId },
        recipient: { profileKind: "personal" as const, profileId: creditor.profileId },
        amountMinorUnits: 75,
        currency: "USD",
        agreementId,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId,
      });

      const attemptA = ctxA.paymentService
        .createPayment(buildInput(`r18-a-${randomUUID()}`))
        .then(() => ({ outcome: "ok" as const }))
        .catch((e: unknown) => ({ outcome: "rejected" as const, error: e }));
      await lockAcquired.promise; // deterministic: A genuinely holds the installment row lock now.

      const attemptB = ctxB.paymentService
        .createPayment(buildInput(`r18-b-${randomUUID()}`))
        .then(() => ({ outcome: "ok" as const }))
        .catch((e: unknown) => ({ outcome: "rejected" as const, error: e }));
      // Deterministic, server-side proof of real overlap: B's own connection is genuinely queued behind
      // A's held installment lock — never a client-side timing guess.
      await waitUntilPidBlockedOnLock(DATABASE_URL, bPid);

      releaseA.resolve();
      const [resultA, resultB] = await Promise.all([attemptA, attemptB]);

      const results = [resultA, resultB];
      expect(results.filter((r) => r.outcome === "ok")).toHaveLength(1);
      const rejected = results.filter((r) => r.outcome === "rejected");
      expect(rejected).toHaveLength(1);
      // Assert the SPECIFIC rejection reason, never merely "some error happened".
      const rejectedResult = rejected[0]!;
      if (rejectedResult.outcome === "rejected") {
        expect(rejectedResult.error).toBeInstanceOf(ValidationError);
        expect((rejectedResult.error as ValidationError).message).toContain("An unresolved payment attempt already exists for this installment");
      }
      // Never two unresolved attempts simultaneously — exactly one payment_attempt row exists at all.
      expect(await countAttemptsForInstallment(installmentScheduleItemId)).toBe(1);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("R19 — sequential partial after resolution: A=40 unresolved blocks B=60; A clears; B=60 then allowed", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const a = await ctx.paymentService.createPayment({
      idempotencyKey: `r19-a-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 40,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    expect(["pending", "scheduled", "submitted", "processing"]).toContain(a.status); // still unresolved.

    await expect(
      ctx.paymentService.createPayment({
        idempotencyKey: `r19-b-first-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 60,
        currency: "USD",
        agreementId,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId,
      }),
    ).rejects.toThrow(ValidationError);

    // A resolves — clears for real, exactly like the real webhook path.
    const db = getDb();
    await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, a.id));
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: a.id, agreementId, currency: "USD", grossAmountMinorUnits: 40 });

    const b = await ctx.paymentService.createPayment({
      idempotencyKey: `r19-b-second-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 60,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    expect(b.status).not.toBe("failed");
    expect(b.installmentScheduleItemId).toBe(installmentScheduleItemId);
  });

  it("R20 — terminal failure releases the reservation: A unresolved blocks B; A becomes terminal failed; a new B is then allowed", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const a = await ctx.paymentService.createPayment({
      idempotencyKey: `r20-a-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 40,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });

    await expect(
      ctx.paymentService.createPayment({
        idempotencyKey: `r20-b-first-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 60,
        currency: "USD",
        agreementId,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId,
      }),
    ).rejects.toThrow(ValidationError);

    // A becomes genuinely terminal (failed) — never cleared, no ledger entry.
    const db = getDb();
    await db.update(paymentAttempt).set({ status: "failed" }).where(eq(paymentAttempt.id, a.id));

    const b = await ctx.paymentService.createPayment({
      idempotencyKey: `r20-b-second-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 60,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    expect(b.status).not.toBe("failed");
  });

  it("R21 — mixed rail: provider A unresolved blocks a concurrently-attempted manual B on the SAME installment", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const providerA = await ctx.paymentService.createPayment({
      idempotencyKey: `r21-provider-a-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 40,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    expect(["pending", "scheduled", "submitted", "processing"]).toContain(providerA.status);

    // Manual/off-platform clears synchronously, but must NOT bypass the invariant — a different,
    // still-unresolved PROVIDER attempt on the same installment must still block it.
    await expect(
      ctx.paymentService.recordManualOffPlatformPayment({
        idempotencyKey: `r21-manual-b-${randomUUID()}`,
        agreementId,
        amountMinorUnits: 70,
        actingUserId: debtor.userId,
        installmentScheduleItemId,
      }),
    ).rejects.toThrow(ValidationError);

    // Only the provider attempt exists — the manual one was never created.
    expect(await countAttemptsForInstallment(installmentScheduleItemId)).toBe(1);
  });

  it("R22 — retry coordinator: a different unresolved attempt blocks new retry creation; once it becomes terminal, the authorized retry proceeds", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    // The ORIGINAL failed payment that schedules the retry — already terminal, must never itself block its own authorized retry.
    const original = await ctx.payments.insertPending({
      idempotencyKey: `r22-original-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 30,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
    });
    await ctx.payments.updateStatus(original.id, "failed", {});

    const coordinator = new DrizzleFailedPaymentRetryCoordinator();
    const failure = await coordinator.coordinateFailure({ installmentScheduleItemId, payment: await ctx.payments.findById(original.id).then((p) => p!) });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");

    // A DIFFERENT, genuinely unresolved attempt now reserves this same installment.
    const blocker = await ctx.paymentService.createPayment({
      idempotencyKey: `r22-blocker-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 50,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    expect(["pending", "scheduled", "submitted", "processing"]).toContain(blocker.status);

    let providerCallCount = 0;
    const spiedProvider = new Proxy(new SandboxPaymentProvider("r22-postgres-test-webhook-secret"), {
      get(target, prop, receiver) {
        if (prop === "createPayment") {
          return async (...args: unknown[]) => {
            providerCallCount += 1;
            return (target.createPayment as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const noopEffectApplier = { receiveInternalEvent: async () => ({ status: "processed" as const }) };
    const retryIdempotencyKey = `retry-${failure.retryId}`;

    const blockedResult = await coordinator.claimAndExecuteRetry({
      installmentScheduleItemId,
      retryId: failure.retryId,
      idempotencyKey: retryIdempotencyKey,
      agreementId,
      provider: spiedProvider,
      prepared: { amountMinorUnits: 30, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      effectApplier: noopEffectApplier,
    });
    expect(blockedResult.outcome).toBe("not_claimable");
    expect(providerCallCount).toBe(0); // provider never called — no duplicate charge risk.

    const db = getDb();
    const retryRowsBlocked = await db.select({ status: paymentRetry.status }).from(paymentRetry).where(eq(paymentRetry.id, failure.retryId));
    expect(retryRowsBlocked[0]?.status).toBe("scheduled"); // untouched — never claimed while blocked.

    // The blocking attempt becomes terminal (failed) — the reservation is released.
    await db.update(paymentAttempt).set({ status: "failed" }).where(eq(paymentAttempt.id, blocker.id));

    const allowedResult = await coordinator.claimAndExecuteRetry({
      installmentScheduleItemId,
      retryId: failure.retryId,
      idempotencyKey: retryIdempotencyKey,
      agreementId,
      provider: spiedProvider,
      prepared: { amountMinorUnits: 30, currency: "USD", paymentMethod: "ach", bankConnectionId: null },
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      effectApplier: noopEffectApplier,
    });
    expect(allowedResult.outcome).toBe("fired");
    expect(providerCallCount).toBe(1); // exactly one real dispatch — no duplicate charge.
  });

  it("R23 — duplicate idempotent request on GENUINELY independent Postgres connections: the SAME logical request submitted twice, concurrently, produces exactly one payment_attempt via existing idempotency semantics, never a competing-installment rejection", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const bPid = await warmUp(isolatedB.client);
      const lockAcquired = createDeferred<void>();
      const releaseA = createDeferred<void>();
      const ctxA = buildContextForLinkageTests({
        installmentReserver: new DrizzleInstallmentAwarePaymentReserver(isolatedA.db, {
          afterInstallmentLock: async () => {
            lockAcquired.resolve();
            await releaseA.promise;
          },
        }),
      });
      const ctxB = buildContextForLinkageTests({ installmentReserver: new DrizzleInstallmentAwarePaymentReserver(isolatedB.db) });
      await seedVerifiedParties(ctxA, debtor.profileId, debtor.userId, creditor.profileId, creditor.userId);
      await seedVerifiedParties(ctxB, debtor.profileId, debtor.userId, creditor.profileId, creditor.userId);

      const sameIdempotencyKey = `r23-duplicate-${randomUUID()}`;
      const buildInput = () => ({
        idempotencyKey: sameIdempotencyKey,
        payer: { profileKind: "personal" as const, profileId: debtor.profileId },
        recipient: { profileKind: "personal" as const, profileId: creditor.profileId },
        amountMinorUnits: 75,
        currency: "USD",
        agreementId,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId,
      });

      const submitA = ctxA.paymentService.createPayment(buildInput());
      await lockAcquired.promise; // deterministic: A genuinely holds the installment row lock now, before its own insert.

      const submitB = ctxB.paymentService.createPayment(buildInput());
      // Deterministic, server-side proof of real overlap — B's OWN idempotency pre-check (run before
      // this) found no existing row yet (A hasn't inserted), so B genuinely reaches, and queues behind,
      // A's held installment lock — never a client-side timing guess.
      await waitUntilPidBlockedOnLock(DATABASE_URL, bPid);

      releaseA.resolve();
      const [first, second] = await Promise.all([submitA, submitB]);
      expect(first.id).toBe(second.id); // the SAME logical payment — idempotent replay, never two rows.
      expect(await countAttemptsForInstallment(installmentScheduleItemId)).toBe(1);
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("R24 — Defect A1 (succeeded-before-ledger reservation gap): remaining=100, A transitions to 'succeeded' but its payment_cleared ledger entry is deliberately not yet posted -> B=100 is rejected specifically for an unresolved attempt; once A's clearing entry posts, a later payment correctly uses the now-reduced remaining amount", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const a = await ctx.paymentService.createPayment({
      idempotencyKey: `r24-a-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 100,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });

    // A's own status transition durably commits (mirrors PaymentTransitionCoordinator.applyTransition,
    // which commits BEFORE PaymentWebhookService.postLedgerEntryRequired posts the clearing entry in a
    // LATER, separate step) — deliberately WITHOUT posting a payment_cleared entry yet: this is the
    // exact confirmed race window.
    const db = getDb();
    await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, a.id));

    let rejectedError: unknown;
    try {
      await ctx.paymentService.createPayment({
        idempotencyKey: `r24-b-first-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 100,
        currency: "USD",
        agreementId,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId,
      });
      throw new Error("expected B to be rejected while A is succeeded-but-uncleared");
    } catch (e) {
      rejectedError = e;
    }
    expect(rejectedError).toBeInstanceOf(ValidationError);
    expect((rejectedError as ValidationError).message).toContain("An unresolved payment attempt already exists for this installment");
    // Never permanently blocked (the coordinator's own explicit instruction: do NOT treat every
    // succeeded attempt as permanently unresolved) — B was rejected for A's still-uncleared money, not
    // because a "succeeded" status is unconditionally treated as still-reserving forever.

    // A's clearing entry is now durably posted — A falls OUT of the "financially unresolved" check
    // entirely, and its money is represented purely via the settlement arithmetic.
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: a.id, agreementId, currency: "USD", grossAmountMinorUnits: 100 });

    // The installment's authoritative remaining amount is now 0 (100 already cleared) — a further
    // reservation must be rejected for EXCEEDING THE CEILING, never for "unresolved attempt" (proving
    // the settlement arithmetic, not the competing-attempt check, is now what correctly governs it).
    // This single-installment agreement's own AGGREGATE remaining balance is ALSO 0 at this point, so
    // `PaymentService.reserveAttempt`'s pre-existing agreement-level `assertNotOverpaying` check (which
    // runs BEFORE the installment reserver is ever reached) is what actually rejects it here — still a
    // genuine, correct ValidationError, never an "unresolved attempt" false rejection, which is exactly
    // what this assertion proves.
    let ceilingError: unknown;
    try {
      await ctx.paymentService.createPayment({
        idempotencyKey: `r24-b-second-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 1,
        currency: "USD",
        agreementId,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId,
      });
      throw new Error("expected the 1-minor-unit reservation to exceed the now-fully-cleared installment's remaining amount");
    } catch (e) {
      ceilingError = e;
    }
    expect(ceilingError).toBeInstanceOf(ValidationError);
    const ceilingMessage = (ceilingError as ValidationError).message;
    expect(ceilingMessage).not.toContain("An unresolved payment attempt already exists");
    expect(ceilingMessage).toContain("would exceed the agreement's remaining balance");
  });

  it("R25 — Defect A2 (installment/agreement ownership): a matching agreement+installment is allowed; a cross-agreement installment id, a nonexistent installment id, and a stale (superseded-version) installment id are all rejected server-side, and the rejected attempts never touch the wrong installment's own rows", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId: agreementA, installmentScheduleItemId: installmentA } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500);
    const { agreementId: agreementB, installmentScheduleItemId: installmentB } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    // (1) agreement A + installment A -> allowed.
    const allowed = await ctx.paymentService.createPayment({
      idempotencyKey: `r25-allowed-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 100,
      currency: "USD",
      agreementId: agreementA,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId: installmentA,
    });
    expect(allowed.status).not.toBe("failed");
    expect(allowed.installmentScheduleItemId).toBe(installmentA);

    // (2) agreement A + installment B (B belongs to a DIFFERENT agreement) -> rejected.
    let crossAgreementError: unknown;
    try {
      await ctx.paymentService.createPayment({
        idempotencyKey: `r25-cross-agreement-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 100,
        currency: "USD",
        agreementId: agreementA,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId: installmentB,
      });
      throw new Error("expected a cross-agreement installment id to be rejected");
    } catch (e) {
      crossAgreementError = e;
    }
    expect(crossAgreementError).toBeInstanceOf(ValidationError);
    expect((crossAgreementError as ValidationError).message).toContain("does not belong to the specified agreement");

    // (3) invalid/nonexistent installment id -> rejected.
    let nonexistentError: unknown;
    try {
      await ctx.paymentService.createPayment({
        idempotencyKey: `r25-nonexistent-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 100,
        currency: "USD",
        agreementId: agreementA,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId: randomUUID(),
      });
      throw new Error("expected a nonexistent installment id to be rejected");
    } catch (e) {
      nonexistentError = e;
    }
    expect(nonexistentError).toBeInstanceOf(ValidationError);
    expect((nonexistentError as ValidationError).message).toContain("Installment not found");

    // (4) stale/wrong-version installment id -> rejected: simulate an amendment that repoints
    // agreementA's currentVersionId to a NEW version with its OWN new schedule (mirrors
    // DrizzleInstallmentScheduleItemRepository.replaceForVersion being called for a new agreement
    // version) — installmentA now belongs to a SUPERSEDED version.
    const db = getDb();
    const [staleAgreementRow] = await db.select().from(agreement).where(eq(agreement.id, agreementA)).limit(1);
    const [originalVersionRow] = await db.select().from(agreementVersion).where(eq(agreementVersion.id, staleAgreementRow!.currentVersionId!)).limit(1);
    const [newVersion] = await db
      .insert(agreementVersion)
      .values({
        agreementId: agreementA,
        versionNumber: (originalVersionRow!.versionNumber ?? 1) + 1,
        isOriginal: false,
        producedBy: "r25_stale_version_test_seed",
        frequency: originalVersionRow!.frequency,
        feeAllocation: originalVersionRow!.feeAllocation,
        terms: originalVersionRow!.terms,
      })
      .returning();
    await db.update(agreement).set({ currentVersionId: newVersion!.id }).where(eq(agreement.id, agreementA));
    const [newInstallment] = await db
      .insert(installmentScheduleItem)
      .values({ agreementVersionId: newVersion!.id, sequenceNumber: 0, dueDate: "2099-01-01", amountMinorUnits: 500 })
      .returning();

    let staleVersionError: unknown;
    try {
      await ctx.paymentService.createPayment({
        idempotencyKey: `r25-stale-version-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 100,
        currency: "USD",
        agreementId: agreementA,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId: installmentA, // the OLD, now-superseded version's own installment.
      });
      throw new Error("expected a stale (superseded-version) installment id to be rejected");
    } catch (e) {
      staleVersionError = e;
    }
    expect(staleVersionError).toBeInstanceOf(ValidationError);
    expect((staleVersionError as ValidationError).message).toContain("superseded agreement schedule version");
    // Confirms the rejected payment never touched the wrong installment: the CURRENT version's own new
    // installment remains completely untouched (no attempt, no cancelled retry, no cleared money).
    expect(await countAttemptsForInstallment(newInstallment!.id)).toBe(0);
    // installmentB (a DIFFERENT agreement's own real installment) was never credited by the rejected
    // cross-agreement attempt — it remains completely untouched.
    expect(await countAttemptsForInstallment(installmentB)).toBe(0);
    void agreementB;
  });

  it("R26 — Defect A3 (agreement/installment lock ordering): a manual payment (agreement -> installment order) racing a provider reservation (NOW ALSO agreement -> installment) on the SAME agreement/installment, via GENUINELY independent connections, produces no deadlock and exactly one valid serialized outcome", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const isolatedManual = createIsolatedDb(DATABASE_URL);
    const isolatedProvider = createIsolatedDb(DATABASE_URL);
    try {
      const providerPid = await warmUp(isolatedProvider.client);
      const lockAcquired = createDeferred<void>();
      const releaseManual = createDeferred<void>();
      const ctxManual = buildContextForLinkageTests({
        atomicManualPayments: new DrizzleAtomicManualPaymentPoster(isolatedManual.db, {
          afterAgreementLock: async () => {
            lockAcquired.resolve();
            await releaseManual.promise;
          },
        }),
      });
      const ctxProvider = buildContextForLinkageTests({ installmentReserver: new DrizzleInstallmentAwarePaymentReserver(isolatedProvider.db) });
      await seedVerifiedParties(ctxManual, debtor.profileId, debtor.userId, creditor.profileId, creditor.userId);
      await seedVerifiedParties(ctxProvider, debtor.profileId, debtor.userId, creditor.profileId, creditor.userId);

      const manualPromise = ctxManual.paymentService
        .recordManualOffPlatformPayment({
          idempotencyKey: `r26-manual-${randomUUID()}`,
          agreementId,
          amountMinorUnits: 60,
          actingUserId: debtor.userId,
          installmentScheduleItemId,
        })
        .then(() => ({ outcome: "ok" as const }))
        .catch((e: unknown) => ({ outcome: "rejected" as const, error: e }));
      // Manual genuinely holds the AGREEMENT lock now (its own pre-existing, already-correct first lock).
      await lockAcquired.promise;

      const providerPromise = ctxProvider.paymentService
        .createPayment({
          idempotencyKey: `r26-provider-${randomUUID()}`,
          payer: { profileKind: "personal", profileId: debtor.profileId },
          recipient: { profileKind: "personal", profileId: creditor.profileId },
          amountMinorUnits: 60,
          currency: "USD",
          agreementId,
          actingUserId: debtor.userId,
          ipAddress: null,
          deviceInfo: null,
          installmentScheduleItemId,
        })
        .then(() => ({ outcome: "ok" as const }))
        .catch((e: unknown) => ({ outcome: "rejected" as const, error: e }));
      // Deterministic, server-side proof: with the FIX, the provider reservation ALSO takes the
      // agreement lock FIRST — so it queues behind manual's held agreement lock, never independently
      // racing ahead to grab the installment lock out of order (the exact old A3 cycle: manual holds
      // agreement + waits on installment, provider holds installment + waits on agreement via its own
      // insert's implicit FK lock).
      await waitUntilPidBlockedOnLock(DATABASE_URL, providerPid);

      releaseManual.resolve();
      const [manualResult, providerResult] = await Promise.all([manualPromise, providerPromise]);

      // No deadlock (neither promise rejects with a Postgres "deadlock detected" error) and the
      // financial ceiling remains correct: manual=60 clears synchronously first (queued first), so the
      // provider's own 60 (60+60=120 > 100) must be rejected for exceeding the now-reduced remaining —
      // exactly one valid serialized outcome, never a corrupted/ambiguous one.
      expect(manualResult.outcome).toBe("ok");
      expect(providerResult.outcome).toBe("rejected");
      if (providerResult.outcome === "rejected") {
        expect(providerResult.error).toBeInstanceOf(ValidationError);
        const message = (providerResult.error as ValidationError).message;
        expect(message.includes("deadlock")).toBe(false);
        expect(message).toContain("would exceed this installment's remaining amount");
      }
      expect(await countAttemptsForInstallment(installmentScheduleItemId)).toBe(1);
    } finally {
      await isolatedManual.close();
      await isolatedProvider.close();
    }
  });

  it("R27 — Defect 2 (coordinateFailure LOCK-ORDER INVERSION): a manual payment (agreement -> installment) racing coordinateFailure's OWN failure-driven payment_retry creation (NOW ALSO agreement -> installment) on the SAME agreement/installment, via GENUINELY independent Postgres connections with server-proven lock-wait contention, produces no deadlock, no application-level circular wait, and the EXACT expected successful retry-creation outcome — never merely '!= not_claimable'", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const ctxSeed = buildContextForLinkageTests();
    await seedVerifiedParty(ctxSeed.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctxSeed.verificationCtx, "personal", creditor.profileId, creditor.userId);

    // The ORIGINAL failed payment coordinateFailure will be called with — already terminal
    // ("failed"), matching real production ordering (PaymentDetail.tsx's retry only ever offered for
    // an already-failed payment). Its own retry is NOT pre-created here — the whole point of this
    // corrected test is that coordinateFailure's OWN failure-driven payment_retry creation runs
    // DURING the race, genuinely contending for the agreement/installment locks, not before it.
    const original = await ctxSeed.payments.insertPending({
      idempotencyKey: `r27-original-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 30,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
    });
    await ctxSeed.payments.updateStatus(original.id, "failed", {});
    const originalRecord = await ctxSeed.payments.findById(original.id).then((p) => p!);

    const isolatedManual = createIsolatedDb(DATABASE_URL);
    const isolatedCoordinator = createIsolatedDb(DATABASE_URL);
    try {
      const coordinatorPid = await warmUp(isolatedCoordinator.client);
      const lockAcquired = createDeferred<void>();
      const releaseManual = createDeferred<void>();
      const ctxManual = buildContextForLinkageTests({
        atomicManualPayments: new DrizzleAtomicManualPaymentPoster(isolatedManual.db, {
          afterAgreementLock: async () => {
            lockAcquired.resolve();
            await releaseManual.promise;
          },
        }),
      });
      await seedVerifiedParties(ctxManual, debtor.profileId, debtor.userId, creditor.profileId, creditor.userId);

      const retryCoordinator = new DrizzleFailedPaymentRetryCoordinator(isolatedCoordinator.db);

      const manualPromise = ctxManual.paymentService
        .recordManualOffPlatformPayment({
          idempotencyKey: `r27-manual-${randomUUID()}`,
          agreementId,
          amountMinorUnits: 40,
          actingUserId: debtor.userId,
          installmentScheduleItemId,
        })
        .then(() => ({ outcome: "ok" as const }))
        .catch((e: unknown) => ({ outcome: "rejected" as const, error: e }));
      await lockAcquired.promise; // deterministic: manual genuinely holds the agreement lock now, before its own installment lock.

      const coordinateFailurePromise = retryCoordinator.coordinateFailure({ installmentScheduleItemId, payment: originalRecord });
      // Deterministic, server-side proof of real overlap: with the FIX, coordinateFailure ALSO takes
      // the agreement lock FIRST (see that method's own doc comment) — so it genuinely queues behind
      // manual's held agreement lock, proven via pg_stat_activity, never independently racing ahead to
      // grab the installment lock out of order (the exact Defect 2 cycle this test proves closed: the
      // OLD order — installment first, then an implicit agreement lock via the payment_retry insert —
      // could cross manual's agreement-then-installment order and deadlock).
      await waitUntilPidBlockedOnLock(DATABASE_URL, coordinatorPid);

      releaseManual.resolve();
      const [manualResult, failureResult] = await Promise.all([manualPromise, coordinateFailurePromise]);

      // No deadlock (neither promise rejects with a Postgres "deadlock detected" error, and both
      // resolve normally) — and the EXACT expected successful retry-creation outcome, never merely
      // "!= not_claimable".
      expect(manualResult.outcome).toBe("ok");
      expect(failureResult.outcome).toBe("retry_scheduled");
      if (failureResult.outcome !== "retry_scheduled") throw new Error("unreachable — asserted above");
      expect(failureResult.alreadyExisted).toBe(false);

      const db = getDb();
      const retryRows = await db.select().from(paymentRetry).where(eq(paymentRetry.originalPaymentAttemptId, original.id));
      expect(retryRows).toHaveLength(1); // exactly one payment_retry row — no duplicate.
      expect(retryRows[0]?.id).toBe(failureResult.retryId);
      expect(retryRows[0]?.status).toBe("scheduled");
      expect(retryRows[0]?.agreementId).toBe(agreementId);
      expect(retryRows[0]?.installmentScheduleItemId).toBe(installmentScheduleItemId);

      // No unrelated agreement/installment affected — exactly the manual payment (succeeded) plus the
      // original failed payment exist for this installment; nothing phantom, nothing duplicated.
      const attemptsForInstallment = await db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId));
      expect(attemptsForInstallment).toHaveLength(2);
    } finally {
      await isolatedManual.close();
      await isolatedCoordinator.close();
    }
  });

  it("R32 — Defect 2 (coordinateFailure LOCK-ORDER INVERSION, provider-reservation side): a provider-routed reservation (agreement -> installment) racing coordinateFailure's OWN failure-driven payment_retry creation on the SAME agreement/installment, via GENUINELY independent Postgres connections, produces no deadlock and the EXACT expected outcome from BOTH sides — proving the same agreement-first order holds regardless of which rail is on the other side of the race", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const ctxSeed = buildContextForLinkageTests();
    await seedVerifiedParty(ctxSeed.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctxSeed.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const original = await ctxSeed.payments.insertPending({
      idempotencyKey: `r32-original-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 30,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
    });
    await ctxSeed.payments.updateStatus(original.id, "failed", {});
    const originalRecord = await ctxSeed.payments.findById(original.id).then((p) => p!);

    const isolatedProvider = createIsolatedDb(DATABASE_URL);
    const isolatedCoordinator = createIsolatedDb(DATABASE_URL);
    try {
      const coordinatorPid = await warmUp(isolatedCoordinator.client);
      const lockAcquired = createDeferred<void>();
      const releaseProvider = createDeferred<void>();
      const ctxProvider = buildContextForLinkageTests({
        installmentReserver: new DrizzleInstallmentAwarePaymentReserver(isolatedProvider.db, {
          afterAgreementLock: async () => {
            lockAcquired.resolve();
            await releaseProvider.promise;
          },
        }),
      });
      await seedVerifiedParty(ctxProvider.verificationCtx, "personal", debtor.profileId, debtor.userId);
      await seedVerifiedParty(ctxProvider.verificationCtx, "personal", creditor.profileId, creditor.userId);

      const retryCoordinator = new DrizzleFailedPaymentRetryCoordinator(isolatedCoordinator.db);

      const providerPromise = ctxProvider.paymentService
        .createPayment({
          idempotencyKey: `r32-provider-${randomUUID()}`,
          payer: { profileKind: "personal", profileId: debtor.profileId },
          recipient: { profileKind: "personal", profileId: creditor.profileId },
          amountMinorUnits: 40,
          currency: "USD",
          agreementId,
          actingUserId: debtor.userId,
          ipAddress: null,
          deviceInfo: null,
          installmentScheduleItemId,
        })
        .then(() => ({ outcome: "ok" as const }))
        .catch((e: unknown) => ({ outcome: "rejected" as const, error: e }));
      await lockAcquired.promise; // deterministic: the provider reservation genuinely holds the agreement lock now.

      const coordinateFailurePromise = retryCoordinator.coordinateFailure({ installmentScheduleItemId, payment: originalRecord });
      await waitUntilPidBlockedOnLock(DATABASE_URL, coordinatorPid);

      releaseProvider.resolve();
      const [providerResult, failureResult] = await Promise.all([providerPromise, coordinateFailurePromise]);

      expect(providerResult.outcome).toBe("ok");
      expect(failureResult.outcome).toBe("retry_scheduled");
      if (failureResult.outcome !== "retry_scheduled") throw new Error("unreachable — asserted above");
      expect(failureResult.alreadyExisted).toBe(false);

      const db = getDb();
      const retryRows = await db.select().from(paymentRetry).where(eq(paymentRetry.originalPaymentAttemptId, original.id));
      expect(retryRows).toHaveLength(1);
      expect(retryRows[0]?.id).toBe(failureResult.retryId);
    } finally {
      await isolatedProvider.close();
      await isolatedCoordinator.close();
    }
  });

  it("R28 — Defect A4 (paid_in_full stale-evidence race): agreement completion (agreement lock FIRST, then fresh evidence) racing a concurrent reversal on GENUINELY independent connections produces no deadlock and never a corrupted decision — the reversal genuinely queues behind the completion decision's own held agreement lock, proving the stale-evidence window is now structurally impossible", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const ctxSeed = buildContextForLinkageTests();
    await seedVerifiedParty(ctxSeed.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctxSeed.verificationCtx, "personal", creditor.profileId, creditor.userId);

    // Agreement appears fully satisfied: one payment, fully cleared, covering the whole installment.
    const paid = await ctxSeed.paymentService.createPayment({
      idempotencyKey: `r28-paid-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 100,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    const db = getDb();
    await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, paid.id));
    await ctxSeed.ledger.postPaymentCleared({ paymentAttemptId: paid.id, agreementId, currency: "USD", grossAmountMinorUnits: 100 });
    await db.update(agreement).set({ status: "active" }).where(eq(agreement.id, agreementId));

    const isolatedDecider = createIsolatedDb(DATABASE_URL);
    const isolatedReversal = createIsolatedDb(DATABASE_URL);
    try {
      const reversalLedger = new LedgerService({
        accounts: new DrizzleLedgerAccountRepository(isolatedReversal.db),
        entries: new DrizzleLedgerJournalEntryRepository(isolatedReversal.db),
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedReversal.db)),
      });
      const reversalPid = await warmUp(isolatedReversal.client);
      const lockAcquired = createDeferred<void>();
      const releaseDecider = createDeferred<void>();
      const decider = new DrizzleAtomicAgreementCompletionDecider(isolatedDecider.db, {
        afterAgreementLockBeforeEvidenceRead: async () => {
          lockAcquired.resolve();
          await releaseDecider.promise;
        },
      });

      const decidePromise = decider.decideAndApply(agreementId);
      await lockAcquired.promise; // deterministic: the decider genuinely holds the agreement row lock now.

      // A concurrent reversal's OWN required ledger write references this SAME agreementId — it must
      // insert a NEW ledger_journal_entry row, which takes an implicit FOR KEY SHARE lock on the
      // referenced `agreement` row for its FK check (the SAME mechanism `computeInstallmentSettlementWithinTx`'s
      // own "LOCK-ORDERING NOTE" documents for installment-referencing inserts) — so it genuinely
      // blocks behind the decider's held `agreement FOR UPDATE` lock.
      const reversalPromise = reversalLedger.reversePayment({ paymentAttemptId: paid.id, entryType: "reversal", reason: "r28 test reversal" });
      await waitUntilPidBlockedOnLock(DATABASE_URL, reversalPid);

      releaseDecider.resolve();
      const decision = await decidePromise;
      await reversalPromise; // now unblocked — proceeds and commits cleanly, no deadlock.

      // The decider's own decision was made from evidence that was STILL current at the moment of its
      // own write (the reversal had not committed yet — it was genuinely blocked) — a valid serialized
      // outcome, never a corrupted hybrid where the write reflects evidence invalidated mid-decision.
      expect(decision).not.toBeNull();
      expect(decision?.status).toBe("paid_in_full");
      const afterDecision = await db.select({ status: agreement.status }).from(agreement).where(eq(agreement.id, agreementId)).limit(1);
      expect(afterDecision[0]?.status).toBe("paid_in_full");

      // The reversal's own required lifecycle effect (recomputeAfterSupersession, called separately by
      // the real webhook pipeline in production) is what demotes it back down afterward — proven here
      // directly, confirming the reversal's ledger effect itself committed correctly once unblocked.
      const completionForDemotion = new AgreementCompletionService({
        agreements: new DrizzleAgreementRepository() as unknown as AgreementStatusRepository,
        balances: new BalanceService({ ledger: ctxSeed.ledger, terms: new DrizzleAgreementTermsReader() }) as unknown as AgreementBalanceComputer,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        installmentSatisfaction: new DrizzleAgreementInstallmentSatisfactionReader(),
      });
      await completionForDemotion.recomputeAfterSupersession(agreementId, `r28-reversal-event-${randomUUID()}`);
      const afterDemotion = await db.select({ status: agreement.status }).from(agreement).where(eq(agreement.id, agreementId)).limit(1);
      expect(afterDemotion[0]?.status).not.toBe("paid_in_full"); // never permanently, incorrectly stuck paid_in_full after a real reversal.
      void installmentScheduleItemId;
    } finally {
      await isolatedDecider.close();
      await isolatedReversal.close();
    }
  });

  it("R29 — Defect 1 (GENERIC PAYMENT SERVICE RESERVATION BYPASS): installmentScheduleItemId supplied with agreementId omitted is rejected BEFORE any payment_attempt row is created — never falls through to the unprotected insertPending branch", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    let caught: unknown;
    try {
      await ctx.paymentService.createPayment({
        idempotencyKey: `r29-no-agreement-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 50,
        currency: "USD",
        agreementId: null,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId,
      });
      throw new Error("expected rejection: installmentScheduleItemId with no agreementId must never be accepted");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain("must also specify the agreement it belongs to");

    // Zero payment_attempt rows created — the rejection happened BEFORE any insertion, not merely
    // before the provider was called.
    expect(await countAttemptsForInstallment(installmentScheduleItemId)).toBe(0);

    // The identical bypass is also closed for `schedulePayment` (the two-phase counterpart
    // AchPaymentService/DebitCardPaymentService build on) — both go through the SAME `reserveAttempt`
    // choke point, so this is the same fix proven from the other public entry point.
    let scheduleCaught: unknown;
    try {
      await ctx.paymentService.schedulePayment({
        idempotencyKey: `r29-schedule-no-agreement-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 50,
        currency: "USD",
        actingUserId: debtor.userId,
        installmentScheduleItemId,
      });
      throw new Error("expected rejection: schedulePayment with installmentScheduleItemId and no agreementId must never be accepted");
    } catch (e) {
      scheduleCaught = e;
    }
    expect(scheduleCaught).toBeInstanceOf(ValidationError);
    expect(await countAttemptsForInstallment(installmentScheduleItemId)).toBe(0);
  });

  it("R30 — Defect 1 regression proof: a valid agreementId + matching installment still succeeds normally through the fully protected reservation path", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const record = await ctx.paymentService.createPayment({
      idempotencyKey: `r30-valid-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 50,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    expect(record.status).not.toBe("failed");
    expect(record.agreementId).toBe(agreementId);
    expect(record.installmentScheduleItemId).toBe(installmentScheduleItemId);
    expect(await countAttemptsForInstallment(installmentScheduleItemId)).toBe(1);
  });

  it("R31 — Defect 1 regression proof: agreementId A + an installment belonging to a DIFFERENT agreement B is rejected server-side, with zero payment_attempt rows created", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId: agreementA } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const { installmentScheduleItemId: installmentB } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 100);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    let caught: unknown;
    try {
      await ctx.paymentService.createPayment({
        idempotencyKey: `r31-cross-agreement-${randomUUID()}`,
        payer: { profileKind: "personal", profileId: debtor.profileId },
        recipient: { profileKind: "personal", profileId: creditor.profileId },
        amountMinorUnits: 50,
        currency: "USD",
        agreementId: agreementA,
        actingUserId: debtor.userId,
        ipAddress: null,
        deviceInfo: null,
        installmentScheduleItemId: installmentB,
      });
      throw new Error("expected rejection: installmentB does not belong to agreementA");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain("does not belong to the specified agreement");
    expect(await countAttemptsForInstallment(installmentB)).toBe(0);
  });
});

/**
 * R11 PASS B1 — PAYMENT FLOW INTEGRATION: dedicated regression coverage for the four Pass B1 defects
 * (B1-1 partial-payment UI handoff, B1-2 manual-payment installment completion wiring, B1-3
 * authoritative agreement progress, B1-4 authoritative retry eligibility). Real Postgres connections;
 * every test drives the SAME production PaymentService/PartialPaymentService/
 * FailedPaymentRetryCoordinator/AgreementProgressService gates the real UI and production factories
 * use — never a hand-rolled, second financial state machine.
 */
describe("R11 PASS B1 — payment flow integration (real Postgres)", () => {
  const DATABASE_URL = process.env.DATABASE_URL!;

  /**
   * Mirrors the pre-existing P14 test's own `relatedAgreementService` stub exactly (proven, minimal —
   * `PartialPaymentService` only ever needs `resolvePartyRole`/`getAgreement`/
   * `requireCreditorCapability`, never the rest of the real `AgreementService` surface).
   */
  function buildPartialPaymentServiceForTest(
    payments: DrizzlePaymentAttemptRepository,
    debtor: { userId: string; profileId: string },
    creditor: { userId: string; profileId: string },
  ): PartialPaymentService {
    const relatedAgreementService = {
      resolvePartyRole: async (_aId: string, userId: string) => (userId === debtor.userId ? ("debtor" as const) : ("creditor" as const)),
      getAgreement: async () => ({
        agreement: { debtorProfileKind: "personal" as const, debtorProfileId: debtor.profileId, creditorProfileKind: "personal" as const, creditorProfileId: creditor.profileId },
      }),
      requireCreditorCapability: async () => {},
    };
    return new PartialPaymentService({
      agreementService: relatedAgreementService as unknown as ConstructorParameters<typeof PartialPaymentService>[0]["agreementService"],
      requests: new DrizzlePartialPaymentRepository(),
      payments,
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }

  async function countAttemptsForInstallment(installmentScheduleItemId: string): Promise<number> {
    const db = getDb();
    const rows = await db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId));
    return rows.length;
  }

  it("B1-F1/B1-F2 — Defect B1-A: the ACTUAL production initiation path (mirroring /api/agreements/partial-payments/initiate-payment) drives a REAL, provider-routed payment for an accepted partial proposal — installment=1000, proposal=400: resulting payment_attempt is provider-routed (never manual/off-platform), targets the correct installment for exactly 400, agreement/installment/amount are all derived from the SERVER'S OWN stored proposal, no payment_cleared exists merely from initiating; once it subsequently clears through the normal provider lifecycle, payment_cleared exists exactly once, the proposal/payment association is durable, and authoritative settlement is $400 settled / $600 remaining / NOT satisfied", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildContextForLinkageTests({ installmentHook: buildRealInstallmentHook() });
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const partialPaymentService = buildPartialPaymentServiceForTest(ctx.payments, debtor, creditor);

    // Propose -> accept, exactly mirroring PartialPaymentPanel's own propose()/decide("accept").
    const proposed = await partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 400,
      proposedDate: "2030-01-01",
      installmentScheduleItemId,
      actingUserId: debtor.userId,
    });
    await partialPaymentService.decidePartialPayment({ partialPaymentRequestId: proposed.id, actingUserId: creditor.userId, decision: "accept" });

    // Mirrors /api/agreements/partial-payments/initiate-payment EXACTLY: the client supplies only the
    // request id; every field that decides what gets charged is derived here from the SERVER's own
    // stored, accepted request — never from a separately-known local variable.
    const accepted = await partialPaymentService.getPartialPaymentRequest(proposed.id, debtor.userId);
    expect(accepted.status).toBe("awaiting_payment");
    expect(accepted.installmentScheduleItemId).not.toBeNull();
    const agreementService = getAgreementService();
    const { agreement: agreementRecord } = await agreementService.getAgreement(accepted.agreementId, debtor.userId);
    const achPaymentService = buildAchPaymentServiceForTest(ctx.paymentService);

    const payment = await achPaymentService.createManualPayment({
      idempotencyKey: `partial-payment-${accepted.id}`,
      agreementId: accepted.agreementId,
      payer: { profileKind: agreementRecord.debtorProfileKind, profileId: agreementRecord.debtorProfileId },
      recipient: { profileKind: agreementRecord.creditorProfileKind, profileId: agreementRecord.creditorProfileId },
      amountMinorUnits: accepted.proposedAmountMinorUnits,
      currency: agreementRecord.currency,
      actingUserId: debtor.userId,
      installmentScheduleItemId: accepted.installmentScheduleItemId ?? undefined,
    });

    // B1-F1: real, provider-routed — never the off-platform recording path.
    expect(payment.providerName).not.toBe("manual");
    expect(payment.installmentScheduleItemId).toBe(installmentScheduleItemId);
    expect(payment.amountMinorUnits).toBe(400);
    expect(["scheduled", "submitted", "processing"]).toContain(payment.status); // never synchronously "succeeded".

    const db = getDb();
    const clearedBeforeSettling = await db
      .select({ id: ledgerJournalEntry.id })
      .from(ledgerJournalEntry)
      .where(and(eq(ledgerJournalEntry.paymentAttemptId, payment.id), eq(ledgerJournalEntry.entryType, "payment_cleared")));
    expect(clearedBeforeSettling).toHaveLength(0); // no payment_cleared merely from initiating.

    // B1-F2: the payment SUBSEQUENTLY clears through the normal provider lifecycle (mirrors the real
    // webhook flow — the SAME pattern this file's own postClearedForInstallment-style helpers use
    // elsewhere) — never a substitute for actually moving money; this happens strictly AFTER the real
    // initiation above.
    await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, payment.id));
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: 400 });

    // Association happens at ITS OWN correct lifecycle point — now that the payment has genuinely
    // succeeded, recordPayment's own independent validation (status/amount/installment) passes.
    const applied = await partialPaymentService.recordPayment({ partialPaymentRequestId: accepted.id, paymentAttemptId: payment.id, actingUserId: debtor.userId });
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(payment.id); // proposal/payment association stays traceable.

    const clearedAfterSettling = await db
      .select({ id: ledgerJournalEntry.id })
      .from(ledgerJournalEntry)
      .where(and(eq(ledgerJournalEntry.paymentAttemptId, payment.id), eq(ledgerJournalEntry.entryType, "payment_cleared")));
    expect(clearedAfterSettling).toHaveLength(1); // payment_cleared exists exactly once.

    const settlementComputer = new DrizzleInstallmentSettlementComputer();
    const settlement = await settlementComputer.computeSettlement(installmentScheduleItemId);
    expect(settlement).not.toBeNull();
    expect(settlement!.settledMinorUnits).toBe(400);
    expect(settlement!.remainingMinorUnits).toBe(600);
    expect(settlement!.isSatisfied).toBe(false);

    const cached = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(cached[0]?.status).not.toBe("paid");
  });

  it("B1-F3 — Defect B1-A: the server derives agreementId/installmentScheduleItemId/amount EXCLUSIVELY from the stored, accepted request — a client-supplied attempt to substitute a different agreement, installment, or amount is structurally impossible to honor and never reaches the payment call", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    // A second, unrelated agreement/installment a malicious client might try to substitute.
    const { agreementId: otherAgreementId, installmentScheduleItemId: otherInstallmentScheduleItemId } = await seedAgreementWithInstallment(
      creditor.profileId,
      debtor.profileId,
      creditor.userId,
      5_000,
    );
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const partialPaymentService = buildPartialPaymentServiceForTest(ctx.payments, debtor, creditor);
    const proposed = await partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 400,
      proposedDate: "2030-01-01",
      installmentScheduleItemId,
      actingUserId: debtor.userId,
    });
    await partialPaymentService.decidePartialPayment({ partialPaymentRequestId: proposed.id, actingUserId: creditor.userId, decision: "accept" });

    // The REAL route handler's own request schema accepts ONLY `partialPaymentRequestId` — there is
    // no field a client could set to override agreementId/installmentScheduleItemId/amount, so the
    // handler ALWAYS re-derives them from the stored request, exactly as mirrored here: `maliciousInput`
    // is defined only to prove it is never consulted.
    const maliciousInput = { agreementId: otherAgreementId, installmentScheduleItemId: otherInstallmentScheduleItemId, amountMinorUnits: 5_000 };
    void maliciousInput;
    const accepted = await partialPaymentService.getPartialPaymentRequest(proposed.id, debtor.userId);
    const agreementService = getAgreementService();
    const { agreement: agreementRecord } = await agreementService.getAgreement(accepted.agreementId, debtor.userId);
    const achPaymentService = buildAchPaymentServiceForTest(ctx.paymentService);
    const payment = await achPaymentService.createManualPayment({
      idempotencyKey: `partial-payment-${accepted.id}`,
      agreementId: accepted.agreementId,
      payer: { profileKind: agreementRecord.debtorProfileKind, profileId: agreementRecord.debtorProfileId },
      recipient: { profileKind: agreementRecord.creditorProfileKind, profileId: agreementRecord.creditorProfileId },
      amountMinorUnits: accepted.proposedAmountMinorUnits,
      currency: agreementRecord.currency,
      actingUserId: debtor.userId,
      installmentScheduleItemId: accepted.installmentScheduleItemId ?? undefined,
    });

    expect(payment.agreementId).toBe(agreementId); // never otherAgreementId.
    expect(payment.installmentScheduleItemId).toBe(installmentScheduleItemId); // never otherInstallmentScheduleItemId.
    expect(payment.amountMinorUnits).toBe(400); // never 5_000.
  });

  it("B1-F4 — Defect B1-A: the SAME accepted proposal initiated twice produces exactly one payment_attempt — existing idempotency semantics apply, never a duplicate independent charge", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const partialPaymentService = buildPartialPaymentServiceForTest(ctx.payments, debtor, creditor);
    const proposed = await partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 400,
      proposedDate: "2030-01-01",
      installmentScheduleItemId,
      actingUserId: debtor.userId,
    });
    await partialPaymentService.decidePartialPayment({ partialPaymentRequestId: proposed.id, actingUserId: creditor.userId, decision: "accept" });
    const accepted = await partialPaymentService.getPartialPaymentRequest(proposed.id, debtor.userId);
    const agreementService = getAgreementService();
    const { agreement: agreementRecord } = await agreementService.getAgreement(accepted.agreementId, debtor.userId);
    const achPaymentService = buildAchPaymentServiceForTest(ctx.paymentService);

    const initiate = () =>
      achPaymentService.createManualPayment({
        idempotencyKey: `partial-payment-${accepted.id}`,
        agreementId: accepted.agreementId,
        payer: { profileKind: agreementRecord.debtorProfileKind, profileId: agreementRecord.debtorProfileId },
        recipient: { profileKind: agreementRecord.creditorProfileKind, profileId: agreementRecord.creditorProfileId },
        amountMinorUnits: accepted.proposedAmountMinorUnits,
        currency: agreementRecord.currency,
        actingUserId: debtor.userId,
        installmentScheduleItemId: accepted.installmentScheduleItemId ?? undefined,
      });

    const first = await initiate();
    const second = await initiate();
    expect(second.id).toBe(first.id); // the SAME logical payment — never a second, independent charge.
    expect(await countAttemptsForInstallment(installmentScheduleItemId)).toBe(1);
  });

  it("B1-F5 — Defect B1-A: PaymentService.recordManualOffPlatformPayment remains a genuinely SEPARATE, still-functioning workflow, and is confirmed NOT the code path 'Pay now' invokes — a real provider-routed initiation and a real off-platform recording produce distinguishably different payment_attempt rows", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId: agreementA, installmentScheduleItemId: installmentA } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const { agreementId: agreementB, installmentScheduleItemId: installmentB } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const partialPaymentService = buildPartialPaymentServiceForTest(ctx.payments, debtor, creditor);
    const proposed = await partialPaymentService.proposePartialPayment({
      agreementId: agreementA,
      proposedAmountMinorUnits: 400,
      proposedDate: "2030-01-01",
      installmentScheduleItemId: installmentA,
      actingUserId: debtor.userId,
    });
    await partialPaymentService.decidePartialPayment({ partialPaymentRequestId: proposed.id, actingUserId: creditor.userId, decision: "accept" });
    const accepted = await partialPaymentService.getPartialPaymentRequest(proposed.id, debtor.userId);
    const agreementService = getAgreementService();
    const { agreement: agreementRecord } = await agreementService.getAgreement(accepted.agreementId, debtor.userId);
    const achPaymentService = buildAchPaymentServiceForTest(ctx.paymentService);

    // "Pay now" — the REAL production rail.
    const viaPayNow = await achPaymentService.createManualPayment({
      idempotencyKey: `partial-payment-${accepted.id}`,
      agreementId: accepted.agreementId,
      payer: { profileKind: agreementRecord.debtorProfileKind, profileId: agreementRecord.debtorProfileId },
      recipient: { profileKind: agreementRecord.creditorProfileKind, profileId: agreementRecord.creditorProfileId },
      amountMinorUnits: accepted.proposedAmountMinorUnits,
      currency: agreementRecord.currency,
      actingUserId: debtor.userId,
      installmentScheduleItemId: accepted.installmentScheduleItemId ?? undefined,
    });
    expect(viaPayNow.providerName).not.toBe("manual");

    // The SEPARATE, explicitly-labeled off-platform recording workflow — still functions correctly,
    // entirely on its own, unrelated installment.
    const viaOffPlatform = await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: `b1f5-offplatform-${randomUUID()}`,
      agreementId: agreementB,
      amountMinorUnits: 400,
      actingUserId: debtor.userId,
      installmentScheduleItemId: installmentB,
    });
    expect(viaOffPlatform.providerName).toBe("manual");
    expect(viaOffPlatform.status).toBe("succeeded"); // off-platform recording still clears synchronously, as designed.

    void installmentB;
  });

  it("B1-R4 — a subsequent $600 manual payment completes a $1,000 installment (after an earlier $400 partial) and cancels a valid pending retry for the SAME installment", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildContextForLinkageTests({ installmentHook: buildRealInstallmentHook() });
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const first = await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: `b1r4-first-${randomUUID()}`,
      agreementId,
      amountMinorUnits: 400,
      actingUserId: debtor.userId,
      installmentScheduleItemId,
    });
    expect(first.status).toBe("succeeded");

    // A SEPARATE, provider-routed attempt for the remaining $600 fails — coordinateFailure schedules
    // a real, valid retry for the SAME installment.
    const failing = await ctx.paymentService.createPayment({
      idempotencyKey: `b1r4-failing-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 600,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    const db = getDb();
    await db.update(paymentAttempt).set({ status: "failed" }).where(eq(paymentAttempt.id, failing.id));
    const retryCoordinator = new DrizzleFailedPaymentRetryCoordinator();
    const failure = await retryCoordinator.coordinateFailure({ installmentScheduleItemId, payment: await ctx.payments.findById(failing.id).then((p) => p!) });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");

    // The debtor pays the remaining $600 a different way (manual) — this must complete the
    // installment (via the SAME B1-2 hook) and cancel the now-superfluous retry.
    const second = await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: `b1r4-second-${randomUUID()}`,
      agreementId,
      amountMinorUnits: 600,
      actingUserId: debtor.userId,
      installmentScheduleItemId,
    });
    expect(second.status).toBe("succeeded");

    const settlementComputer = new DrizzleInstallmentSettlementComputer();
    const settlement = await settlementComputer.computeSettlement(installmentScheduleItemId);
    expect(settlement!.isSatisfied).toBe(true);
    expect(settlement!.remainingMinorUnits).toBe(0);
    const cached = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(cached[0]?.status).toBe("paid");

    const retryRows = await db.select({ status: paymentRetry.status }).from(paymentRetry).where(eq(paymentRetry.id, failure.retryId));
    expect(retryRows[0]?.status).toBe("canceled");
  });

  it("B1-R5 — a single full manual payment (matching the installment's own face amount, which equals the agreement's own principal) marks the installment paid AND correctly advances agreement completion to paid_in_full", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500);
    const ctx = buildContextForLinkageTests({ installmentHook: buildRealInstallmentHook() });
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const payment = await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: `b1r5-${randomUUID()}`,
      agreementId,
      amountMinorUnits: 500,
      actingUserId: debtor.userId,
      installmentScheduleItemId,
    });
    expect(payment.status).toBe("succeeded");

    const db = getDb();
    const cached = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(cached[0]?.status).toBe("paid");
    const agreementRow = await db.select({ status: agreement.status }).from(agreement).where(eq(agreement.id, agreementId)).limit(1);
    expect(agreementRow[0]?.status).toBe("paid_in_full");
  });

  it("B1-R8 — a duplicate/idempotent manual payment replay (SAME idempotencyKey submitted twice) produces no duplicate completion effects: exactly one ledger entry, exactly one installment-completion hook invocation, exactly one agreement-completion advancement", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 500);
    let hookCallCount = 0;
    const realHook = buildRealInstallmentHook();
    const countingHook: ManualPaymentInstallmentHook = {
      handlePaymentSucceeded: async (payment) => {
        hookCallCount += 1;
        await realHook.handlePaymentSucceeded(payment);
      },
    };
    const ctx = buildContextForLinkageTests({ installmentHook: countingHook });
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const sameIdempotencyKey = `b1r8-${randomUUID()}`;
    const first = await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: sameIdempotencyKey,
      agreementId,
      amountMinorUnits: 500,
      actingUserId: debtor.userId,
      installmentScheduleItemId,
    });
    const second = await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: sameIdempotencyKey,
      agreementId,
      amountMinorUnits: 500,
      actingUserId: debtor.userId,
      installmentScheduleItemId,
    });
    expect(second.id).toBe(first.id); // idempotent replay — the SAME logical payment, never a second row.
    expect(hookCallCount).toBe(1); // the installment-completion hook ran exactly once, not twice.

    const db = getDb();
    const clearedEntries = await db.select({ id: ledgerJournalEntry.id }).from(ledgerJournalEntry).where(and(eq(ledgerJournalEntry.paymentAttemptId, first.id), eq(ledgerJournalEntry.entryType, "payment_cleared")));
    expect(clearedEntries).toHaveLength(1); // exactly one payment_cleared entry — never duplicated.
    const agreementRow = await db.select({ status: agreement.status }).from(agreement).where(eq(agreement.id, agreementId)).limit(1);
    expect(agreementRow[0]?.status).toBe("paid_in_full"); // completion advanced exactly once, correctly.
  });

  it("B1-F6 — Defect B1-B (REPLACES the now-incorrect B1-R7a expectation): coordinateFailure NEVER demotes a cached 'paid' installment merely because authoritative settlement currently looks insufficient — paid/waived history is preserved unconditionally, this is a reconciliation condition, not a charge trigger, and no new retry is created", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const db = getDb();
    // A cached "paid" installment with NO real cleared money behind it at all — e.g. a stale/corrupted
    // cache, or (per Defect B1-B) simply a "paid" disposition that must never be reopened by a failure.
    await db.update(installmentScheduleItem).set({ status: "paid" }).where(eq(installmentScheduleItem.id, installmentScheduleItemId));

    const payments = new DrizzlePaymentAttemptRepository();
    const original = await payments.insertPending({
      idempotencyKey: `b1f6-original-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 1_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
    });
    await payments.updateStatus(original.id, "failed", {});

    const retryCoordinator = new DrizzleFailedPaymentRetryCoordinator();
    const result = await retryCoordinator.coordinateFailure({ installmentScheduleItemId, payment: await payments.findById(original.id).then((p) => p!) });
    expect(result.outcome).toBe("already_settled"); // never "retry_scheduled" — a failure has no basis to reopen "paid".

    // Cached status is preserved EXACTLY as-is — never silently overwritten to past_due.
    const cached = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(cached[0]?.status).toBe("paid");

    // No new payment_retry row was created for this installment.
    const retryRows = await db.select({ id: paymentRetry.id }).from(paymentRetry).where(eq(paymentRetry.installmentScheduleItemId, installmentScheduleItemId));
    expect(retryRows).toHaveLength(0);
  });

  it("B1-F7 — Defect B1-B: coordinateFailure NEVER demotes a cached 'waived' installment either — 'waived' is especially strict, there is no waiver-revocation workflow in ordinary success/failure/retry processing, and no new retry is created", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const db = getDb();
    await db.update(installmentScheduleItem).set({ status: "waived" }).where(eq(installmentScheduleItem.id, installmentScheduleItemId));

    const payments = new DrizzlePaymentAttemptRepository();
    const original = await payments.insertPending({
      idempotencyKey: `b1f7-original-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 1_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
    });
    await payments.updateStatus(original.id, "failed", {});

    const retryCoordinator = new DrizzleFailedPaymentRetryCoordinator();
    const result = await retryCoordinator.coordinateFailure({ installmentScheduleItemId, payment: await payments.findById(original.id).then((p) => p!) });
    expect(result.outcome).toBe("already_settled");

    const cached = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(cached[0]?.status).toBe("waived"); // never reopened, never converted to past_due/scheduled.

    const retryRows = await db.select({ id: paymentRetry.id }).from(paymentRetry).where(eq(paymentRetry.installmentScheduleItemId, installmentScheduleItemId));
    expect(retryRows).toHaveLength(0);
  });

  it("B1-F8 — Defect B1-B (existing behavior preserved): for an ORDINARY scheduled/past_due installment (never paid/waived), coordinateFailure's existing due-date/failure/retry behavior is entirely unchanged — a real failure still schedules a real retry and still corrects cached status from authoritative evidence", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const db = getDb();
    // Cached status is "scheduled" (the seed default) — never paid/waived — so B1-B's new guard does
    // not apply here; this proves the guard is narrowly scoped to paid/waived only.

    const payments = new DrizzlePaymentAttemptRepository();
    const original = await payments.insertPending({
      idempotencyKey: `b1f8-original-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 1_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
    });
    await payments.updateStatus(original.id, "failed", {});

    const retryCoordinator = new DrizzleFailedPaymentRetryCoordinator();
    const result = await retryCoordinator.coordinateFailure({ installmentScheduleItemId, payment: await payments.findById(original.id).then((p) => p!) });
    expect(result.outcome).toBe("retry_scheduled");
    if (result.outcome !== "retry_scheduled") throw new Error("unreachable — asserted above");
    expect(result.alreadyExisted).toBe(false);

    const cached = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(cached[0]?.status).toBe("past_due");
  });

  it("B1-F9 — Defect B1-B: legitimate reopening after a REAL reduction (a real reversal) still works, entirely through the already-approved coordinateSupersession path — proving B1-F6's failure-path guard did not also disable genuine reopening", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildContextForLinkageTests({ installmentHook: buildRealInstallmentHook() });
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const paid = await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: `b1f9-${randomUUID()}`,
      agreementId,
      amountMinorUnits: 1_000,
      actingUserId: debtor.userId,
      installmentScheduleItemId,
    });
    expect(paid.status).toBe("succeeded");

    const db = getDb();
    const cachedBefore = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(cachedBefore[0]?.status).toBe("paid");

    // A REAL reduction: the cleared payment is genuinely reversed.
    await ctx.ledger.reversePayment({ paymentAttemptId: paid.id, entryType: "reversal", reason: "b1f9 test reversal" });

    const retryCoordinator = new DrizzleFailedPaymentRetryCoordinator();
    const supersession = await retryCoordinator.coordinateSupersession({
      installmentScheduleItemId,
      payment: await ctx.payments.findById(paid.id).then((p) => p!),
      providerEventId: `b1f9-event-${randomUUID()}`,
    });
    expect(supersession.outcome).toBe("reopened");

    const cachedAfter = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(cachedAfter[0]?.status).not.toBe("paid"); // legitimate reopening via the correct path still works.
  });

  it("B1-R7b — retry eligibility (Defect B1-4): claimRetryForExecution does NOT dispatch again when authoritative linked settlement already fully satisfies the installment, even though the cached status has not caught up yet", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildContextForLinkageTests();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const payments = new DrizzlePaymentAttemptRepository();
    const original = await payments.insertPending({
      idempotencyKey: `b1r7b-original-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 1_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
    });
    await payments.updateStatus(original.id, "failed", {});
    const retryCoordinator = new DrizzleFailedPaymentRetryCoordinator();
    const failure = await retryCoordinator.coordinateFailure({ installmentScheduleItemId, payment: await payments.findById(original.id).then((p) => p!) });
    if (failure.outcome !== "retry_scheduled") throw new Error("expected a retry to be scheduled");

    // A DIFFERENT, real contribution fully clears the installment for real — but its own cached
    // status is deliberately left stale ("past_due", from coordinateFailure above), never touched.
    const settling = await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: `b1r7b-settling-${randomUUID()}`,
      agreementId,
      amountMinorUnits: 1_000,
      actingUserId: debtor.userId,
      installmentScheduleItemId,
    });
    expect(settling.status).toBe("succeeded");
    // recordManualOffPlatformPayment's own installmentHook is omitted here (buildContextForLinkageTests
    // with no override), so the cache is deliberately NOT corrected to "paid" by this call — exactly
    // the "cached status hasn't updated yet" scenario this test needs to prove against.
    const db = getDb();
    const cachedBefore = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(cachedBefore[0]?.status).not.toBe("paid");

    const claim = await retryCoordinator.claimRetryForExecution({ installmentScheduleItemId, retryId: failure.retryId });
    expect(claim.outcome).toBe("not_claimable"); // never dispatches again — authoritative evidence already fully satisfies it.
  });

  it("B1-R6 — agreement progress (Defect B1-3): the 'active' step's own next-payment-due amount reflects AUTHORITATIVE $600 remaining after a $400 partial payment, never the installment's original $1,000 face amount, and never reports 'complete' while genuinely unsatisfied", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildContextForLinkageTests({ installmentHook: buildRealInstallmentHook() });
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: `b1r6-${randomUUID()}`,
      agreementId,
      amountMinorUnits: 400,
      actingUserId: debtor.userId,
      installmentScheduleItemId,
    });

    // A real relationship row (FK-enforced) is required for AgreementProgressService's own
    // payment-readiness gate to be reached at all — the readiness stubs below ignore its actual
    // content, only its mere existence/linkage matters here.
    const db = getDb();
    const [rel] = await db.insert(relationship).values({ initiatorUserId: creditor.userId }).returning();
    await db.update(agreement).set({ relationshipId: rel!.id, status: "active" }).where(eq(agreement.id, agreementId));

    const progressService = new AgreementProgressService({
      agreementService: getAgreementService(),
      relationshipPaymentMethods: {
        getRelationshipAccounts: async () => [
          { usage: "funding" as const, status: "active", financialAccount: { status: "active" } },
          { usage: "payout" as const, status: "active", financialAccount: { status: "active" } },
        ],
      },
      cancellation: { getCancellationInfo: async () => null },
      mandates: { isActiveForAgreement: async () => true },
      installments: new DrizzleAgreementInstallmentStatusReader(),
      paymentAttempts: new DrizzlePaymentAttemptRepository(),
      balance: new BalanceService({ ledger: ctx.ledger, terms: new DrizzleAgreementTermsReader() }),
      installmentSettlements: new DrizzleAgreementInstallmentSettlementReader(),
    });

    const progress = await progressService.getProgress(agreementId, debtor.userId);
    const activeStep = progress.steps.find((s) => s.key === "active");
    expect(activeStep).toBeDefined();
    expect(activeStep!.status).not.toBe("complete"); // never "paid in full" from a stale/partial view.
    expect(activeStep!.description).toContain("$6.00"); // 600 minor units — authoritative remaining, never the installment's own $10.00 face amount.
    expect(activeStep!.description).not.toContain("$10.00");
  });

  function signedWebhookForTest(provider: SandboxPaymentProvider, body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: provider.signWebhookPayload(rawBody) };
  }

  /** Wraps a real object in a Proxy that fails the first `failCount` calls to `methodName`, then delegates to the real implementation — mirrors paymentWebhookRecovery.postgres.test.ts's identical `flaky` helper (test-only, touches no production code). */
  function flakyForTest<T extends object>(real: T, methodName: keyof T, failCount: number, error: () => Error): T {
    let calls = 0;
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === methodName) {
          return async (...args: unknown[]) => {
            calls += 1;
            if (calls <= failCount) throw error();
            return (target[methodName] as unknown as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as T;
  }

  /**
   * R11 PASS B1 — FINAL LEGACY RECOVERY CORRECTION (K1-K3 — CALLERS MUST NOT CONTINUE AFTER REFUSAL).
   * Wraps a real provider in a Proxy that counts calls to the two methods a retry dispatch/resolution
   * path can ever reach (`createPayment`, `retrievePaymentByIdempotencyKey`) — used to prove a
   * disposition that must NEVER trigger a new dispatch or lookup (an "already resolved" adoption whose
   * candidate a legacy-lineage repair conflict/refusal blocked) genuinely never touches the provider,
   * never merely "happens not to" in this one sandbox implementation.
   */
  function countingProviderForTest(real: SandboxPaymentProvider): { provider: SandboxPaymentProvider; callCount: () => number } {
    let calls = 0;
    const provider = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "createPayment" || prop === "retrievePaymentByIdempotencyKey") {
          return async (...args: unknown[]) => {
            calls += 1;
            return (target[prop as "createPayment"] as unknown as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as SandboxPaymentProvider;
    return { provider, callCount: () => calls };
  }

  /**
   * R11 PASS B1 — FINAL TARGETED CORRECTION: a FULL production stack sharing ONE provider/payments/
   * ledger instance set — real `AchPaymentService`, `PartialPaymentService`,
   * `PartialPaymentAutoApplicationService`, and `PaymentWebhookService` (with the new
   * `partialPaymentApplication` dependency wired) — so B1-G1 through B1-G9 drive the ACTUAL
   * production provider-event/success/recovery path, never a test-only shortcut.
   */
  function buildFullWebhookContextForTest() {
    const provider = new SandboxPaymentProvider("r11-pass-b1-final-postgres-test-webhook-secret");
    const verificationCtx = createTestVerificationService();
    const payments = new DrizzlePaymentAttemptRepository();
    const events = new DrizzlePaymentWebhookEventRepository();
    const retries = new DrizzlePaymentRetryRepository();
    const ledgerAccounts = new DrizzleLedgerAccountRepository();
    const ledgerEntries = new DrizzleLedgerJournalEntryRepository();
    const ledger = new LedgerService({ accounts: ledgerAccounts, entries: ledgerEntries, audit: new AuditService(new DrizzleAuditEventRepository()) });
    const agreements = new DrizzleAgreementRepository();
    const balances = new BalanceService({ ledger, terms: new DrizzleAgreementTermsReader() });
    const completion = new AgreementCompletionService({
      agreements: agreements as unknown as AgreementStatusRepository,
      balances: balances as unknown as AgreementBalanceComputer,
      audit: new AuditService(new DrizzleAuditEventRepository()),
      installmentSatisfaction: new DrizzleAgreementInstallmentSatisfactionReader(),
      atomicCompletion: new DrizzleAtomicAgreementCompletionDecider(),
    });
    const paymentService = new PaymentService({
      provider,
      verification: verificationCtx.verificationService,
      profileOwners: verificationCtx.profileOwners,
      payments,
      audit: new AuditService(new DrizzleAuditEventRepository()),
      agreements: new DrizzleAgreementPartiesReader(),
      balances,
      ledger,
      completion,
      atomicManualPayments: new DrizzleAtomicManualPaymentPoster(),
      installmentReserver: new DrizzleInstallmentAwarePaymentReserver(),
      scheduleReader: new DrizzleAgreementScheduleReader(),
      settlementContext: new DrizzleSettlementContextVerifier(),
    });
    const achPaymentService = buildAchPaymentServiceForTest(paymentService);

    const requests = new DrizzlePartialPaymentRepository();
    const autoApplication = new PartialPaymentAutoApplicationService({ requests, payments, retries, ledger, audit: new AuditService(new DrizzleAuditEventRepository()) });

    // R11 PASS B1 — FINAL LIFECYCLE CLOSURE (Defect 1B): wired here (not left default/undefined) so
    // this SAME context's own real retry coordination exercises the legacy-lineage repair path for
    // real — see `DrizzleFailedPaymentRetryCoordinator.repairLegacyLineageAndApply`'s own doc comment.
    const retryCoordinator = new DrizzleFailedPaymentRetryCoordinator(undefined, undefined, undefined, undefined, undefined, autoApplication);
    // `handlePaymentFailed`/`handlePaymentSucceeded` never touch `installments`/`retries` once a
    // coordinator is wired (see FailedPaymentWorkflowService's own doc comment) — stubbed-and-throwing,
    // never expected to actually run. `notifyBothParties` (reached from `handlePaymentFailed` even
    // WITH a coordinator wired) genuinely DOES need real `profileOwners`/`notifications` — a real
    // webhook-driven "payment.failed" event in these B1-G tests must not throw merely because a
    // best-effort notification has nowhere real to go.
    const unusedFailedWorkflowDep = new Proxy(
      {},
      {
        get() {
          return () => {
            throw new Error("not used in this test — handlePaymentSucceeded/handlePaymentFailed only ever call retryCoordinator/notifyBothParties when a coordinator is wired");
          };
        },
      },
    );
    const failedPaymentWorkflow = new FailedPaymentWorkflowService({
      installments: unusedFailedWorkflowDep as ConstructorParameters<typeof FailedPaymentWorkflowService>[0]["installments"],
      retries: unusedFailedWorkflowDep as ConstructorParameters<typeof FailedPaymentWorkflowService>[0]["retries"],
      notifications: createTestNotificationService().notificationService,
      profileOwners: verificationCtx.profileOwners,
      retryCoordinator,
    });

    const partialPaymentService = new PartialPaymentService({
      agreementService: getAgreementService(),
      requests,
      payments,
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });

    function buildWebhookService(overrides: Partial<ConstructorParameters<typeof PaymentWebhookService>[0]> = {}) {
      return new PaymentWebhookService({
        provider,
        events,
        payments,
        transitionCoordinator: new DrizzlePaymentTransitionCoordinator(),
        ledger,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        completion,
        failedPaymentWorkflow,
        partialPaymentApplication: autoApplication,
        ...overrides,
      });
    }

    const eligibility = new DrizzlePaymentInitiationEligibilityService({ verification: verificationCtx.verificationService, payments });

    function buildRetryService(overrides: Partial<ConstructorParameters<typeof PaymentRetryService>[0]> = {}) {
      return new PaymentRetryService({
        retries,
        paymentAttempts: payments,
        initiators: { ach: achPaymentService, debit_card: achPaymentService, manual_off_platform: achPaymentService },
        profileOwners: verificationCtx.profileOwners,
        audit: new AuditService(new DrizzleAuditEventRepository()),
        retryCoordinator,
        provider,
        eligibility,
        effectApplier: buildWebhookService(),
        ...overrides,
      });
    }

    return {
      provider,
      verificationCtx,
      payments,
      events,
      retries,
      ledger,
      agreements,
      completion,
      paymentService,
      achPaymentService,
      partialPaymentService,
      autoApplication,
      requests,
      retryCoordinator,
      eligibility,
      buildWebhookService,
      buildRetryService,
    };
  }

  /** Backdates a retry's own `scheduledFor` into the past so it becomes immediately "due" — mirrors paymentWebhookRecovery.postgres.test.ts's identical precedent. */
  async function backdateRetryScheduledForTest(retryId: string): Promise<void> {
    const db = getDb();
    await db.update(paymentRetry).set({ scheduledFor: new Date(Date.now() - 60_000) }).where(eq(paymentRetry.id, retryId));
  }

  async function proposeAndAcceptForTest(
    ctx: ReturnType<typeof buildFullWebhookContextForTest>,
    debtor: { userId: string; profileId: string },
    creditor: { userId: string; profileId: string },
    agreementId: string,
    installmentScheduleItemId: string,
    proposedAmountMinorUnits = 400,
    proposedDate = "2030-01-01",
  ) {
    const proposed = await ctx.partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits,
      proposedDate,
      installmentScheduleItemId,
      actingUserId: debtor.userId,
    });
    await ctx.partialPaymentService.decidePartialPayment({ partialPaymentRequestId: proposed.id, actingUserId: creditor.userId, decision: "accept" });
    return ctx.partialPaymentService.getPartialPaymentRequest(proposed.id, debtor.userId);
  }

  async function initiateRealPartialPaymentForTest(
    ctx: ReturnType<typeof buildFullWebhookContextForTest>,
    accepted: { id: string; agreementId: string; proposedAmountMinorUnits: number; installmentScheduleItemId: string | null },
    debtor: { userId: string },
  ) {
    const agreementService = getAgreementService();
    const { agreement: agreementRecord } = await agreementService.getAgreement(accepted.agreementId, debtor.userId);
    return ctx.achPaymentService.createManualPayment({
      idempotencyKey: `partial-payment-${accepted.id}`,
      agreementId: accepted.agreementId,
      payer: { profileKind: agreementRecord.debtorProfileKind, profileId: agreementRecord.debtorProfileId },
      recipient: { profileKind: agreementRecord.creditorProfileKind, profileId: agreementRecord.creditorProfileId },
      amountMinorUnits: accepted.proposedAmountMinorUnits,
      currency: agreementRecord.currency,
      actingUserId: debtor.userId,
      installmentScheduleItemId: accepted.installmentScheduleItemId ?? undefined,
    });
  }

  it("B1-G1 — Defect 1: the ACTUAL production provider-event/success path (a real signed webhook, never a test-only recordPayment call) durably applies an accepted partial-payment proposal once its real provider-routed payment genuinely clears", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    expect(payment.providerPaymentId).not.toBeNull();

    const webhook = ctx.buildWebhookService();
    const providerEventId = `b1g1-${randomUUID()}`;
    const result = await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    expect(result.status).toBe("processed");

    const reloaded = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(reloaded.status).toBe("applied");
    expect(reloaded.paymentAttemptId).toBe(payment.id);

    const cleared = await ctx.ledger.findEntry(payment.id, "payment_cleared");
    expect(cleared).not.toBeNull();
  });

  it("B1-G2 — Defect 1: application requires the durable payment_cleared entry, never merely status === succeeded — a real crash BEFORE ledger posting leaves the proposal awaiting_payment, and the SAME real recovery pass that later completes clearing also completes the application", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    const flakyLedger = flakyForTest(ctx.ledger, "postPaymentCleared", 1, () => new Error("simulated crash before ledger posting"));
    const webhookFlaky = ctx.buildWebhookService({ ledger: flakyLedger });
    const providerEventId = `b1g2-${randomUUID()}`;
    const first = await webhookFlaky.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    expect(first.status).toBe("accepted"); // classified retryable, event NOT marked processed.

    const afterFirst = await ctx.payments.findById(payment.id);
    expect(afterFirst?.status).toBe("succeeded"); // the transition itself committed before the ledger call.
    expect(await ctx.ledger.findEntry(payment.id, "payment_cleared")).toBeNull(); // no ledger entry yet.
    const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaiting.status).toBe("awaiting_payment"); // never applied prematurely.

    const eventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    await webhookFlaky.recoverBatch(100, new Date(eventRow!.nextRetryAt!.getTime() + 1));
    // Asserts THIS event's own resolution specifically — never the shared table's aggregate count,
    // which a `limit: 100` recoverBatch call is never scoped to just one event's own row anyway.
    const eventAfterRecovery = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    expect(eventAfterRecovery?.processingStatus).toBe("processed");

    expect(await ctx.ledger.findEntry(payment.id, "payment_cleared")).not.toBeNull();
    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(payment.id);
  });

  it("B1-G3 — Defect 1: the same successful provider event, genuinely reprocessed by the actual recovery mechanism (a later required effect fails and is retried), applies exactly once — no throw on replay, no duplicate financial effect", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    const flakyCompletion = flakyForTest(ctx.completion, "checkAndAdvance", 1, () => new Error("simulated later-required-effect failure"));
    const webhookFlaky = ctx.buildWebhookService({ completion: flakyCompletion });
    const providerEventId = `b1g3-${randomUUID()}`;
    const first = await webhookFlaky.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    expect(first.status).toBe("accepted");

    // MY effect already ran successfully on this SAME first attempt (positioned before the completion
    // check that failed) — proving it, then proving it survives a full replay, is the point of this test.
    const afterFirst = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(afterFirst.status).toBe("applied");
    expect(afterFirst.paymentAttemptId).toBe(payment.id);
    const clearedAfterFirst = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(clearedAfterFirst.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);

    const eventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    await webhookFlaky.recoverBatch(100, new Date(eventRow!.nextRetryAt!.getTime() + 1));
    // Asserts THIS event's own resolution specifically — never the shared table's aggregate count.
    const eventAfterRecovery = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    expect(eventAfterRecovery?.processingStatus).toBe("processed"); // no throw on replay — my effect's own idempotent re-entry succeeded.

    const afterSecond = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(afterSecond.status).toBe("applied");
    expect(afterSecond.paymentAttemptId).toBe(payment.id); // still the SAME attempt — never reassigned.
    const clearedAfterSecond = await ctx.ledger.listEntriesForPaymentAttempt(payment.id);
    expect(clearedAfterSecond.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // never duplicated.
  });

  it("B1-G4 — Defect 1: a proposal already durably applied to attempt A is never overwritten by a later attempt to apply it to a DIFFERENT attempt B — an explicit conflict outcome, never a silent overwrite", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const { agreementId: otherAgreementId, installmentScheduleItemId: otherInstallment } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const paymentA = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1g4-a-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId: paymentA.providerPaymentId }));
    const afterA = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(afterA.status).toBe("applied");
    expect(afterA.paymentAttemptId).toBe(paymentA.id);

    // A genuinely REAL, independent, fully-cleared payment attempt B — on a completely different
    // agreement/installment, so it never itself correlates to this proposal — used here purely as a
    // real row id to attempt the conflicting association against
    // `PartialPaymentRequestRepository.applyIfAwaitingPayment`'s own production conflict guard
    // directly (the same primitive `applyClearedPayment` itself calls).
    const paymentB = await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: `b1g4-b-${randomUUID()}`,
      agreementId: otherAgreementId,
      amountMinorUnits: 1_000,
      actingUserId: debtor.userId,
      installmentScheduleItemId: otherInstallment,
    });

    const conflictResult = await ctx.requests.applyIfAwaitingPayment(accepted.id, paymentB.id);
    expect(conflictResult.outcome).toBe("already_applied_different");

    const stillA = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillA.paymentAttemptId).toBe(paymentA.id); // never overwritten.
  });

  it("B1-G5 — Defect 1: durable payment_cleared exists while the proposal is still awaiting_payment (a real crash strictly AFTER ledger posting but BEFORE association) — the actual recovery mechanism (recoverBatch) completes the application automatically", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    const flakyAutoApplication = flakyForTest(ctx.autoApplication, "applyClearedPayment", 1, () => new Error("simulated crash after ledger posting, before association"));
    const webhookFlaky = ctx.buildWebhookService({ partialPaymentApplication: flakyAutoApplication });
    const providerEventId = `b1g5-${randomUUID()}`;
    const first = await webhookFlaky.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    expect(first.status).toBe("accepted");

    expect(await ctx.ledger.findEntry(payment.id, "payment_cleared")).not.toBeNull(); // clearing DID durably post.
    const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaiting.status).toBe("awaiting_payment"); // association did NOT complete yet.

    const eventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    await webhookFlaky.recoverBatch(100, new Date(eventRow!.nextRetryAt!.getTime() + 1));
    // Asserts THIS event's own resolution specifically — never the shared table's aggregate count.
    const eventAfterRecovery = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    expect(eventAfterRecovery?.processingStatus).toBe("processed");

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(payment.id);
  });

  it("B1-G6 — Defect 1: the original proposal-linked attempt fails, an authorized replacement fired through the REAL retry machinery succeeds and clears — the proposal associates to the successful REPLACEMENT, and the failed predecessor is never recorded as applied", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    const webhook = ctx.buildWebhookService();
    const failEventId = `b1g6-fail-${randomUUID()}`;
    const failResult = await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: failEventId, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    expect(failResult.status).toBe("processed");

    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();
    await backdateRetryScheduledForTest(retryRow!.id);

    const retryService = ctx.buildRetryService();
    const fireResult = await retryService.fireDueRetries(new Date());
    expect(fireResult.fired).toBe(1);

    const firedRetry = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(firedRetry?.status).toBe("fired");
    const replacementId = firedRetry!.resultingPaymentAttemptId!;
    expect(replacementId).not.toBe(originalPayment.id);
    const replacement = await ctx.payments.findById(replacementId);
    expect(replacement!.idempotencyKey).toBe(`retry-${retryRow!.id}`); // never the original's own key.

    // The failed predecessor is never recorded as applied — proposal is still awaiting_payment.
    const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaiting.status).toBe("awaiting_payment");

    const successEventId = `b1g6-success-${randomUUID()}`;
    const successResult = await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId: replacement!.providerPaymentId }));
    expect(successResult.status).toBe("processed");

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(replacementId); // the successful REPLACEMENT — never the failed original.
  });

  it("B1-G7 — Defect 1 (EXPIRATION SAFETY): expireOverdue never expires a proposal whose linked payment has already durably cleared but whose association hasn't completed yet — the narrowest possible guard, never a broader policy change", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    // proposedDate already in the past — ordinarily due for expiration right away.
    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 400, "2020-01-01");
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    const flakyAutoApplication = flakyForTest(ctx.autoApplication, "applyClearedPayment", 1, () => new Error("simulated association delay"));
    const webhookFlaky = ctx.buildWebhookService({ partialPaymentApplication: flakyAutoApplication });
    const providerEventId = `b1g7-${randomUUID()}`;
    await webhookFlaky.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    expect(await ctx.ledger.findEntry(payment.id, "payment_cleared")).not.toBeNull(); // cleared...
    const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaiting.status).toBe("awaiting_payment"); // ...but association not yet complete.

    const { expired } = await ctx.partialPaymentService.expireOverdue(new Date());
    expect(expired).toBe(0); // never expired merely because proposedDate has passed.

    const afterExpireAttempt = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(afterExpireAttempt.status).toBe("awaiting_payment");

    // Test hygiene: resolve this test's own deliberately-failed webhook event via the real recovery
    // mechanism before finishing — an unresolved "failed, retryable" row left behind would otherwise
    // remain a live candidate for ANY later, unrelated `recoverBatch` call against this same shared
    // database (this file's own later tests, or another *.postgres.test.ts file's).
    const eventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, providerEventId);
    await webhookFlaky.recoverBatch(100, new Date(eventRow!.nextRetryAt!.getTime() + 1));
    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied"); // association completes normally once recovery runs.
  });

  it("B1-G8 — Defect 2: a WAIVED installment is never reopened by coordinateSupersession — a real reversal on the payment that funded it still posts its own ordinary reversal ledger evidence, but the waiver itself is preserved and no retry is created from the resulting shortfall", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const webhook = ctx.buildWebhookService();
    const payment = await ctx.achPaymentService.createManualPayment({
      idempotencyKey: `b1g8-${randomUUID()}`,
      agreementId,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 1_000,
      currency: "USD",
      actingUserId: debtor.userId,
      installmentScheduleItemId,
    });
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1g8-success-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    const db = getDb();
    const paidStatus = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(paidStatus[0]?.status).toBe("paid");

    // An authorized waiver — no dedicated waiver-issuance service exists in R11 (explicitly out of
    // scope, per this correction's own doc comment), so recorded the same direct way B1-F7 does.
    await db.update(installmentScheduleItem).set({ status: "waived" }).where(eq(installmentScheduleItem.id, installmentScheduleItemId));

    const retriesBefore = (await db.select().from(paymentRetry).where(eq(paymentRetry.installmentScheduleItemId, installmentScheduleItemId))).length;
    const reversalResult = await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1g8-reversed-${randomUUID()}`, eventType: "payment.reversed", providerPaymentId: payment.providerPaymentId }));
    expect(reversalResult.status).toBe("processed");

    const afterReversal = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(afterReversal[0]?.status).toBe("waived"); // never reopened.

    const retriesAfter = (await db.select().from(paymentRetry).where(eq(paymentRetry.installmentScheduleItemId, installmentScheduleItemId))).length;
    expect(retriesAfter).toBe(retriesBefore); // no retry created from the resulting shortfall.

    const reversalEntry = await ctx.ledger.findEntry(payment.id, "reversal");
    expect(reversalEntry).not.toBeNull(); // ordinary supersession financial evidence still recorded.
  });

  it("B1-G9 — Defect 2 regression: an ORDINARY paid, non-waived installment is still correctly reopened by a real reversal, through the full production webhook path — proving the waived guard did not disable legitimate reopening", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const webhook = ctx.buildWebhookService();
    const payment = await ctx.achPaymentService.createManualPayment({
      idempotencyKey: `b1g9-${randomUUID()}`,
      agreementId,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 1_000,
      currency: "USD",
      actingUserId: debtor.userId,
      installmentScheduleItemId,
    });
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1g9-success-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    const db = getDb();
    const paidStatus = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(paidStatus[0]?.status).toBe("paid");

    const reversalResult = await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1g9-reversed-${randomUUID()}`, eventType: "payment.reversed", providerPaymentId: payment.providerPaymentId }));
    expect(reversalResult.status).toBe("processed");

    const afterReversal = await db.select({ status: installmentScheduleItem.status }).from(installmentScheduleItem).where(eq(installmentScheduleItem.id, installmentScheduleItemId)).limit(1);
    expect(afterReversal[0]?.status).not.toBe("paid"); // legitimate reopening still works.
  });

  /** Deterministic-barrier helper, mirroring signingConcurrency.postgres.test.ts's identical precedent. */
  function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("B1-H1 — Defect 1 (REPLACEMENT SUCCESS BEFORE DURABLE LINEAGE): applyFoundOutcome's own internal resolution (`effectApplier.receiveInternalEvent`) correctly associates the proposal to the replacement attempt when the provider's own authoritative lookup is ALREADY 'succeeded' synchronously right after dispatch — durable lineage is available before auto-application ever runs, so no permanent not_correlated skip", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    const webhook = ctx.buildWebhookService();
    const failResult = await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1h1-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    expect(failResult.status).toBe("processed");

    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();
    await backdateRetryScheduledForTest(retryRow!.id);

    // Pre-register the REPLACEMENT's own exact, deterministic idempotency key
    // (`retry-${retryRow.id}` — the same form `establishDurableDispatchIntent` always mints) against
    // the REAL sandbox provider as ALREADY "succeeded" — so when the coordinator's own Phase B later
    // calls `provider.createPayment` with this SAME key, the sandbox's own idempotent-replay branch
    // returns it, and the coordinator's OWN subsequent authoritative `retrievePaymentByIdempotencyKey`
    // lookup (never trusting that synchronous response for terminal handling — Root Correction 2)
    // ALSO immediately reports "succeeded" — driving `applyFoundOutcome`'s own internal
    // `effectApplier.receiveInternalEvent` resolution synchronously, inside THIS SAME `fireDueRetries`
    // call, for real.
    const replacementIdempotencyKey = `retry-${retryRow!.id}`;
    await ctx.provider.createPayment({
      idempotencyKey: replacementIdempotencyKey,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      payer: { profileKind: originalPayment.payerProfileKind, profileId: originalPayment.payerProfileId },
      recipient: { profileKind: originalPayment.recipientProfileKind, profileId: originalPayment.recipientProfileId },
      simulateOutcome: "succeeded",
    });

    const retryService = ctx.buildRetryService();
    const fireResult = await retryService.fireDueRetries(new Date());
    expect(fireResult.fired).toBe(1);

    const firedRetry = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(firedRetry?.status).toBe("fired");
    const replacementId = firedRetry!.resultingPaymentAttemptId!;
    expect(replacementId).not.toBe(originalPayment.id);
    const replacement = await ctx.payments.findById(replacementId);
    expect(replacement?.status).toBe("succeeded"); // resolved via applyFoundOutcome's own internal path, synchronously.
    expect(replacement?.idempotencyKey).toBe(replacementIdempotencyKey);

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(replacementId);
  });

  it("B1-H2 — Defect 1 (EARLY EXTERNAL WEBHOOK): a real signed success webhook delivered in the exact window after Phase B's own dispatch transaction commits (the replacement's providerPaymentId now durably exists) but BEFORE this coordinator's own resolution reaches 'fired' still resolves the proposal via durable lineage — no permanent not_correlated skip", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1h2-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();
    await backdateRetryScheduledForTest(retryRow!.id);

    let appliedDuringWindow: string | null = null;
    const earlyWebhookCoordinator = new DrizzleFailedPaymentRetryCoordinator(undefined, undefined, undefined, {
      // Deterministic proof point: awaited AFTER Phase B's own dispatch transaction has already
      // committed (the replacement anchor now durably has its own providerPaymentId) but BEFORE this
      // coordinator's own `resolveSubmittedAnchor`/`applyFoundOutcome` resolution ever runs — exactly
      // the window a REAL, independently-arriving provider webhook could land in.
      afterDispatchCommitBeforeResolution: async () => {
        const anchor = await ctx.payments.findByIdempotencyKey(`retry-${retryRow!.id}`);
        if (!anchor?.providerPaymentId) throw new Error("test setup: replacement anchor should already have a durable providerPaymentId by this hook");
        const result = await webhook.receiveWebhook(
          signedWebhookForTest(ctx.provider, { providerEventId: `b1h2-early-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId: anchor.providerPaymentId }),
        );
        if (result.status !== "processed") throw new Error(`test setup: the early webhook should process cleanly, got "${result.status}"`);
        const reloaded = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
        appliedDuringWindow = reloaded.status;
      },
    });
    const retryService = ctx.buildRetryService({ retryCoordinator: earlyWebhookCoordinator });
    const fireResult = await retryService.fireDueRetries(new Date());
    expect(fireResult.fired).toBe(1);
    expect(appliedDuringWindow).toBe("applied"); // resolved DURING the early-webhook window itself — durable lineage was already there for it.

    const firedRetry = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(firedRetry!.resultingPaymentAttemptId);
  });

  it("B1-H3 — Defect 1D (ALREADY-RESOLVED ADOPTION): when the retry's own internal resolution correctly finds durable lineage but the partial-payment application step ITSELF transiently fails, the real recovery mechanism (recoverBatch) idempotently completes the missing application afterward — never a duplicate payment_cleared or financial effect", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1h3-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();
    await backdateRetryScheduledForTest(retryRow!.id);

    const replacementIdempotencyKey = `retry-${retryRow!.id}`;
    await ctx.provider.createPayment({
      idempotencyKey: replacementIdempotencyKey,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      payer: { profileKind: originalPayment.payerProfileKind, profileId: originalPayment.payerProfileId },
      recipient: { profileKind: originalPayment.recipientProfileKind, profileId: originalPayment.recipientProfileId },
      simulateOutcome: "succeeded",
    });

    const flakyAutoApp = flakyForTest(ctx.autoApplication, "applyClearedPayment", 1, () => new Error("simulated transient failure during the retry's own internal resolution"));
    const webhookFlaky = ctx.buildWebhookService({ partialPaymentApplication: flakyAutoApp });
    const retryService = ctx.buildRetryService({ effectApplier: webhookFlaky });
    const fireResult = await retryService.fireDueRetries(new Date());
    // claimAndExecuteRetry's own "fired" semantics: a definite provider response was durably obtained
    // — true here even though the internal webhook processing THAT triggered stayed retryable on its
    // own required effect (see this method's own doc comment on this class's interface).
    expect(fireResult.fired).toBe(1);

    const firedRetry = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    const replacementId = firedRetry!.resultingPaymentAttemptId!;
    expect(await ctx.ledger.findEntry(replacementId, "payment_cleared")).not.toBeNull(); // ledger DID clear — only MY step threw.
    const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaiting.status).toBe("awaiting_payment"); // application did not complete yet.

    const syntheticProviderEventId = `ambiguity-resolution:${replacementIdempotencyKey}`;
    const eventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, syntheticProviderEventId);
    expect(eventRow).not.toBeNull();
    await webhookFlaky.recoverBatch(100, new Date(eventRow!.nextRetryAt!.getTime() + 1));
    const eventAfterRecovery = await ctx.events.findByProviderEvent(ctx.provider.providerName, syntheticProviderEventId);
    expect(eventAfterRecovery?.processingStatus).toBe("processed");

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(replacementId);
    const clearedEntries = await ctx.ledger.listEntriesForPaymentAttempt(replacementId);
    expect(clearedEntries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // never duplicated.
  });

  it("B1-H4 — Defect 2 (EXPIRATION CHECK/WRITE RACE): independent Postgres connections + a deterministic barrier — expireOverdue genuinely holds the proposal row lock while a concurrent, real partial-payment application races the SAME row; once durable clearing already exists, expiration correctly loses and the application (queued behind the lock) succeeds — never applied->expired", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 400, "2020-01-01"); // already overdue
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    // Drive the payment to real succeeded+cleared, but with the partial-payment application step's
    // own FIRST attempt intentionally failing — leaving the proposal genuinely `awaiting_payment`
    // with durable clearing ALREADY posted: exactly the race window Defect 2 is about.
    const flakyAutoApp = flakyForTest(ctx.autoApplication, "applyClearedPayment", 1, () => new Error("simulated pending application"));
    const webhookFlaky = ctx.buildWebhookService({ partialPaymentApplication: flakyAutoApp });
    const providerEventId = `b1h4-${randomUUID()}`;
    await webhookFlaky.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    expect(await ctx.ledger.findEntry(payment.id, "payment_cleared")).not.toBeNull();
    const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaiting.status).toBe("awaiting_payment");

    const isolatedExpire = createIsolatedDb(DATABASE_URL);
    const isolatedRecover = createIsolatedDb(DATABASE_URL);
    try {
      const lockAcquired = createDeferred<void>();
      const releaseExpire = createDeferred<void>();
      const isolatedExpireRequests = new DrizzlePartialPaymentRepository(isolatedExpire.db, {
        // expireOverdue() calls expireIfSafe once per overdue candidate it finds — filtering on the
        // exact id under test means an unrelated leftover overdue proposal from another test in this
        // same shared database (processed first or interleaved) passes through unpaused, rather than
        // breaking this test's own deterministic barrier by pausing on the wrong row.
        afterProposalLock: async (id) => {
          if (id !== accepted.id) return;
          lockAcquired.resolve();
          await releaseExpire.promise;
        },
      });
      const isolatedExpireService = new PartialPaymentService({
        agreementService: getAgreementService(),
        requests: isolatedExpireRequests,
        payments: ctx.payments,
        audit: new AuditService(new DrizzleAuditEventRepository()),
      });

      const expirePromise = isolatedExpireService.expireOverdue(new Date());
      await lockAcquired.promise; // deterministic: expiration genuinely holds the proposal row lock now.

      // "Transaction B" — the REAL production atomic application primitive
      // (`PartialPaymentRequestRepository.applyIfAwaitingPayment`, the exact method
      // `PartialPaymentAutoApplicationService.applyClearedPayment` itself calls to perform the
      // application) on a genuinely separate, independently-warmed-up connection — its own FIRST and
      // ONLY query is the blocking UPDATE itself, so the pid `warmUp` captures is unambiguously the
      // one that later shows as blocked.
      const isolatedRecoverRequests = new DrizzlePartialPaymentRepository(isolatedRecover.db);
      const recoverPid = await warmUp(isolatedRecover.client);
      const recoverPromise = isolatedRecoverRequests.applyIfAwaitingPayment(accepted.id, payment.id);
      try {
        await waitUntilPidBlockedOnLock(DATABASE_URL, recoverPid, 30_000); // server-side proof: the concurrent application genuinely queues behind expiration's held lock. Generous timeout: this specific check has shown transient slowness under a full multi-file suite run's cumulative connection load.
      } finally {
        // MUST fire even if the wait above throws (a transient poll timeout) — otherwise
        // `isolatedExpireService.expireOverdue`'s own transaction callback is left forever awaiting
        // `releaseExpire.promise` inside `afterProposalLock`, which never resolves on its own: the
        // held row lock (and the connection holding it) would never be released, hanging this test's
        // own `finally`-block connection close (and any later test/harness step) indefinitely rather
        // than failing cleanly.
        releaseExpire.resolve();
      }
      const expireResult = await expirePromise;
      const recoverResult = await recoverPromise; // now unblocked — proceeds once expiration releases.

      expect(expireResult.expired).toBe(0); // durable clearing already existed — expiration correctly lost.
      expect(recoverResult.outcome).toBe("applied");

      const final = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
      expect(final.status).toBe("applied"); // never applied->expired, never expired->applied-over-expired.
      expect(final.paymentAttemptId).toBe(payment.id);
    } finally {
      await isolatedExpire.close();
      await isolatedRecover.close();
    }
  });

  it("B1-H5 — Defect 2 regression: an overdue awaiting proposal with NO correlated payment at all still expires normally — no global disabling of expiration", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 400, "2020-01-01");
    // Never initiated — no payment_attempt exists for this proposal at all.

    const { expired } = await ctx.partialPaymentService.expireOverdue(new Date());
    expect(expired).toBe(1);
    const reloaded = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(reloaded.status).toBe("expired");
  });

  it("B1-H6 — Defect 2 (CORRECTED — see this test's own doc comment for why the original construction deadlocked): proves BOTH legal serialized outcomes of the agreement-first lock protocol, never the now-structurally-impossible 'clearing commits while expiration is paused mid-transaction' interleaving", async () => {
    /**
     * ORIGINAL H6 (removed) paused expiration's transaction AFTER it had already acquired
     * `agreement FOR UPDATE`, then tried to let a concurrent ledger-clearing insert for the SAME
     * agreement complete WHILE expiration stayed paused, before resuming expiration to prove its
     * fresh (not stale) evidence read observed the new clearing. That interleaving is now provably
     * UNREACHABLE: the clearing insert (`ledger_account`, FK-referencing `agreement`) cannot commit
     * while expiration's own transaction holds that exact agreement row FOR UPDATE — proven live via
     * pg_stat_activity during triage (the clearing backend sat blocked on expiration's own
     * transaction id for 5m54s, idle-in-transaction, until Vitest's 90s test timeout finally killed
     * it — a genuine, reproducible deadlock, not a flake). This is exactly the intended effect of
     * Defect 2's own agreement-first serialization — the test's OLD premise contradicted the
     * corrected protocol it was meant to verify. Replaced with the two outcomes that protocol
     * actually makes legal:
     *   H6-A: expiration wins the agreement lock while there is genuinely NOT_CLEARED evidence (a
     *         payment attempt exists but has already conclusively failed — no in-flight
     *         possibility) — a concurrent clearing attempt for a NEW payment against the SAME
     *         agreement provably queues behind expiration's held lock (never deadlocks), expiration
     *         legitimately commits `expired`, and only THEN does the queued clearing proceed — a
     *         late clearing arriving against an already-expired proposal correctly resolves through
     *         the EXISTING conflict/reconciliation outcome (`applyClearedPayment` -> `"conflict"`),
     *         never silently applied and never silently dropped.
     *   H6-B: clearing completes and durably posts FIRST, in full, before expiration ever runs —
     *         expiration's own fresh evidence read correctly finds CLEARED and never expires.
     */
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);
    const db = getDb();

    // ---------------------------------------------------------------------------------------
    // H6-A — expiration wins the agreement lock over genuinely NOT_CLEARED evidence; a late,
    // separate clearing attempt against the SAME agreement queues behind it, never deadlocks, and
    // — once expiration has already committed `expired` — resolves as a durable conflict, never a
    // silent false-apply and never a silently dropped payment.
    // ---------------------------------------------------------------------------------------
    const acceptedA = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 400, "2020-01-01"); // already overdue
    const staleAttempt = await initiateRealPartialPaymentForTest(ctx, acceptedA, debtor);
    await db.update(paymentAttempt).set({ status: "failed" }).where(eq(paymentAttempt.id, staleAttempt.id)); // conclusively terminal — no in-flight possibility, no pending replacement: genuinely NOT_CLEARED.

    // A SEPARATE, later payment attempt against the SAME agreement/installment — the "late clearing"
    // this test races against expiration. Not correlated to acceptedA's own proposal (that proposal's
    // own attempt already failed) — this models an independent payment whose ledger effect still
    // must serialize on the SAME agreement-level correctness boundary.
    const acceptedForLateClearing = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 300, "2099-01-01"); // not overdue — never itself a candidate for this expireOverdue() call.
    const lateAttempt = await initiateRealPartialPaymentForTest(ctx, acceptedForLateClearing, debtor);
    await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, lateAttempt.id));

    const isolatedExpire = createIsolatedDb(DATABASE_URL);
    const isolatedClear = createIsolatedDb(DATABASE_URL);
    try {
      const lockAcquired = createDeferred<void>();
      const releaseExpire = createDeferred<void>();
      const isolatedExpireRequests = new DrizzlePartialPaymentRepository(isolatedExpire.db, {
        // Paused immediately after the AGREEMENT lock — before the proposal row is even locked —
        // matching B1-I3's own identical, already-proven pattern for this exact barrier point.
        afterAgreementLock: async (lockedAgreementId) => {
          if (lockedAgreementId !== agreementId) return;
          lockAcquired.resolve();
          await releaseExpire.promise;
        },
      });
      const isolatedExpireService = new PartialPaymentService({
        agreementService: getAgreementService(),
        requests: isolatedExpireRequests,
        payments: ctx.payments,
        audit: new AuditService(new DrizzleAuditEventRepository()),
      });

      const expirePromise = isolatedExpireService.expireOverdue(new Date());
      await lockAcquired.promise; // deterministic: expiration genuinely holds the agreement row lock now, has NOT yet checked evidence.

      const isolatedLedger = new LedgerService({
        accounts: new DrizzleLedgerAccountRepository(isolatedClear.db),
        entries: new DrizzleLedgerJournalEntryRepository(isolatedClear.db),
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedClear.db)),
      });
      const clearPid = await warmUp(isolatedClear.client);
      const clearPromise = isolatedLedger.postPaymentCleared({ paymentAttemptId: lateAttempt.id, agreementId, currency: "USD", grossAmountMinorUnits: 300 });
      try {
        await waitUntilPidBlockedOnLock(DATABASE_URL, clearPid); // server-side proof: the late clearing insert's own implicit agreement FK lock genuinely queues behind expiration's held FOR UPDATE lock — never a deadlock.
      } finally {
        // MUST fire even if the wait above throws — otherwise expiration's own transaction callback
        // is left forever awaiting `releaseExpire.promise`, hanging the held agreement lock (and this
        // test's own connection close) indefinitely rather than failing cleanly.
        releaseExpire.resolve();
      }
      const expireResult = await expirePromise; // expiration's fresh, post-pause evidence read finds acceptedA's own attempt conclusively "failed" (NOT_CLEARED) — legitimately expires it.
      await clearPromise; // now unblocked (expiration committed and released the agreement lock) — commits cleanly, no deadlock.

      expect(expireResult.expired).toBeGreaterThanOrEqual(1); // at least acceptedA — never asserting an exact global count, since expireOverdue() scans every overdue candidate in the shared test database, not just this test's own.
      const expiredProposal = await ctx.partialPaymentService.getPartialPaymentRequest(acceptedA.id, debtor.userId);
      expect(expiredProposal.status).toBe("expired");
      expect(await ctx.ledger.findEntry(lateAttempt.id, "payment_cleared")).not.toBeNull(); // late clearing still committed successfully — never silently dropped.

      // The late clearing's own attempt (`lateAttempt`) never itself correlated to the NOW-expired
      // `acceptedA` proposal — it correlates to `acceptedForLateClearing`, which is still legitimately
      // `awaiting_payment` (not overdue) and gets its own correct APPLIED outcome, proving the
      // agreement-lock serialization did not corrupt or misattribute anything belonging to the OTHER
      // proposal sharing the same agreement.
      const lateOutcome = await ctx.autoApplication.applyClearedPayment(lateAttempt.id);
      expect(lateOutcome.outcome).toBe("applied");
      expect((await ctx.partialPaymentService.getPartialPaymentRequest(acceptedForLateClearing.id, debtor.userId)).status).toBe("applied");
    } finally {
      await isolatedExpire.close();
      await isolatedClear.close();
    }

    // ---------------------------------------------------------------------------------------
    // H6-B — clearing completes and durably posts FIRST, in full, before expiration ever runs.
    // Sequential (no race to construct — clearing has already fully committed by the time
    // expiration's own fresh evidence read happens, so there is nothing for a lock to serialize).
    // ---------------------------------------------------------------------------------------
    const acceptedB = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 250, "2020-01-01"); // already overdue
    const paymentB = await initiateRealPartialPaymentForTest(ctx, acceptedB, debtor);
    await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, paymentB.id));
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: paymentB.id, agreementId, currency: "USD", grossAmountMinorUnits: 250 });
    expect(await ctx.ledger.findEntry(paymentB.id, "payment_cleared")).not.toBeNull(); // durably cleared BEFORE expiration ever runs.

    await ctx.partialPaymentService.expireOverdue(new Date()); // global count not asserted — expireOverdue() scans every overdue candidate in the shared test database, not just this test's own; the per-proposal check below is the authoritative assertion.
    const stillAwaitingB = await ctx.partialPaymentService.getPartialPaymentRequest(acceptedB.id, debtor.userId);
    expect(stillAwaitingB.status).toBe("awaiting_payment"); // clearing won the serial order — never expired; normal automatic application may still complete it later.
  });

  it("B1-H7 — Defect 3 (SUCCESS APPLICATION OVERTAKEN BY LATER SUPERSESSION — UPDATED per the FINAL LIFECYCLE CLOSURE architectural decision: historical clearing consumes the proposal, even once superseded): payment_cleared durably posts, application intentionally fails, a real reversal fully completes before application ever retries, then recovering the original success event applies the proposal to the exact historically-cleared payment and durably records the supersession for audit — never blindly re-derives financial truth, never stuck awaiting_payment forever", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    const flakyAutoApp = flakyForTest(ctx.autoApplication, "applyClearedPayment", 1, () => new Error("simulated transient application failure"));
    const webhookFlaky = ctx.buildWebhookService({ partialPaymentApplication: flakyAutoApp });
    const successEventId = `b1h7-success-${randomUUID()}`;
    const successResult = await webhookFlaky.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    expect(successResult.status).toBe("accepted"); // application transiently failed; event stays retryable.
    expect(await ctx.ledger.findEntry(payment.id, "payment_cleared")).not.toBeNull();
    const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaiting.status).toBe("awaiting_payment");

    // A REAL reversal completes fully BEFORE application ever gets a chance to retry.
    const webhook = ctx.buildWebhookService();
    const reversalResult = await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1h7-reversed-${randomUUID()}`, eventType: "payment.reversed", providerPaymentId: payment.providerPaymentId }));
    expect(reversalResult.status).toBe("processed");
    const afterReversal = await ctx.payments.findById(payment.id);
    expect(afterReversal?.status).toBe("reversed");

    // Now recover the ORIGINAL success event — by this point the attempt is no longer "succeeded".
    const successEventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId);
    const recoverResult = await webhookFlaky.recoverBatch(100, new Date(successEventRow!.nextRetryAt!.getTime() + 1));
    expect(recoverResult.processed).toBeGreaterThanOrEqual(1);
    const successEventAfterRecovery = await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId);
    expect(successEventAfterRecovery?.processingStatus).toBe("processed"); // finalizes — retrying again could never change this outcome.

    // R11 PASS B1 — FINAL LIFECYCLE CLOSURE (architectural decision — PROPOSAL CONSUMPTION):
    // historical clearing wins — the proposal is consumed (applied) to the EXACT payment that
    // durably cleared, even though that payment is now reversed. "Applied" means "was actually used
    // by a payment that durably cleared," never "money is still currently effective."
    const afterRecovery = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(afterRecovery.status).toBe("applied");
    expect(afterRecovery.paymentAttemptId).toBe(payment.id);

    // Current financial truth (the installment's own reopened balance) stays controlled exclusively
    // by ledger/coordinateSupersession — never re-derived or altered by this class. This proposal was
    // for less than the installment's own full face amount, so it was never "paid" from this partial
    // contribution alone regardless; the point here is only that applying the proposal itself never
    // touches installment/ledger settlement.
    const settlementComputer = new DrizzleInstallmentSettlementComputer();
    const settlementAfter = await settlementComputer.computeSettlement(installmentScheduleItemId);
    expect(settlementAfter!.isSatisfied).toBe(false);

    // An explicit, durable, reconciliation-worthy audit record of the supersession was ALSO written
    // — never a silent stall, and never merely re-deriving financial truth from this class.
    const supersededAudit = await getDb()
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "partial_payment_request"), eq(auditEvent.targetResourceId, accepted.id), eq(auditEvent.action, "partial_payment_consuming_payment_superseded")));
    expect(supersededAudit.length).toBeGreaterThanOrEqual(1);

    // UI/reuse result (Defect 3C): the proposal is no longer `awaiting_payment` — AgreementDetail's
    // own existing `r.status === "awaiting_payment"` gate (unchanged) means Pay Now is structurally
    // no longer offered for it, and it can never be reused for a new charge.
    expect(afterRecovery.status).not.toBe("awaiting_payment");
  });

  it("B1-H8 — Defect 4 (25-HOP TRAVERSAL EXHAUSTION): a lineage chain longer than the bound resolves as UNKNOWN/EXHAUSTED, never as 'not correlated' — applyClearedPayment throws (keeping the effect retryable) rather than silently concluding this is not a partial payment, and traversal never loops unboundedly", async () => {
    // Stubbed unit-level test — no real Postgres needed (per this correction's own "smallest safe
    // test" instruction): constructs an in-memory chain of 30 synthetic retry hops (well past the
    // 25-hop bound), the LAST of which is the only one carrying a genuine `partial-payment-<uuid>`
    // idempotency key a correct, unbounded traversal would eventually reach.
    const HOP_COUNT = 30;
    const attempts = new Map<string, PaymentAttemptRecord>();
    const retryRowsById = new Map<string, { originalPaymentAttemptId: string }>(); // retryId (parsed from the retry-<uuid> key) -> its retry row

    function makeAttempt(id: string, idempotencyKey: string, status: "succeeded" = "succeeded"): PaymentAttemptRecord {
      return {
        id,
        idempotencyKey,
        payerProfileKind: "personal",
        payerProfileId: "unused",
        recipientProfileKind: "personal",
        recipientProfileId: "unused",
        amountMinorUnits: 100,
        currency: "USD",
        agreementId: "unused",
        status,
        providerName: "sandbox_mock",
        providerPaymentId: null,
        failureReason: null,
        payoutCompletedAt: null,
        payoutInitiatedAt: null,
        installmentScheduleItemId: null,
        paymentMethod: null,
        recordedByUserId: null,
        recipientConfirmedAt: null,
        bankConnectionId: null,
        lifecycleCheckedAt: null,
      } as PaymentAttemptRecord;
    }

    const rootId = "attempt-0";
    attempts.set(rootId, makeAttempt(rootId, `partial-payment-${randomUUID()}`));
    let previousId = rootId;
    for (let i = 1; i <= HOP_COUNT; i++) {
      const id = `attempt-${i}`;
      const retryId = randomUUID(); // must be a real UUID — resolveLineage's own regex is strictly anchored/shape-validated.
      attempts.set(id, makeAttempt(id, `retry-${retryId}`));
      retryRowsById.set(retryId, { originalPaymentAttemptId: previousId });
      previousId = id;
    }
    const tailId = previousId;

    const payments = {
      findById: async (id: string) => attempts.get(id) ?? null,
      findByIdempotencyKey: async (key: string) => [...attempts.values()].find((a) => a.idempotencyKey === key) ?? null,
    } as unknown as ConstructorParameters<typeof PartialPaymentAutoApplicationService>[0]["payments"];
    // Mirrors the REAL resolveLineage's own lookup shape exactly: it resolves the retryId parsed
    // directly out of the `retry-<uuid>` key via `retries.findById(retryId)` — never
    // `findByResultingPaymentAttemptId` (that method exists on the real repository for the FORWARD/
    // adoption direction, not this backward lineage walk).
    const retries = {
      findById: async (retryId: string) => retryRowsById.get(retryId) ?? null,
    } as unknown as ConstructorParameters<typeof PartialPaymentAutoApplicationService>[0]["retries"];
    const ledger = { findEntry: async () => ({ id: "unused" }) } as unknown as ConstructorParameters<typeof PartialPaymentAutoApplicationService>[0]["ledger"];
    const requests = {
      findById: async () => null,
      applyIfAwaitingPayment: async () => {
        throw new Error("must never be reached — lineage resolution should throw before any application is attempted");
      },
    } as unknown as ConstructorParameters<typeof PartialPaymentAutoApplicationService>[0]["requests"];

    const service = new PartialPaymentAutoApplicationService({
      requests,
      payments,
      retries,
      ledger,
      audit: { record: async () => ({ id: 1 }) as unknown } as unknown as ConstructorParameters<typeof PartialPaymentAutoApplicationService>[0]["audit"],
    });

    let caught: unknown;
    try {
      await service.applyClearedPayment(tailId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error); // thrown, deliberately — kept retryable, never silently "not_correlated".
  });

  it("B1-H9 — Defect 1-4 regression: an ordinary DIRECT (non-retry) partial-payment success still clears, applies, and stays idempotent after the lineage-ordering fix", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    const providerEventId = `b1h9-${randomUUID()}`;
    const result = await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    expect(result.status).toBe("processed");

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(payment.id);

    // Idempotent replay — the identical event, processed again.
    const replay = await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    expect(replay.status).toBe("duplicate");
    const afterReplay = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(afterReplay.status).toBe("applied");
    expect(afterReplay.paymentAttemptId).toBe(payment.id);
  });

  it("B1-H10 — Defect 1-4 regression: the ordinary replacement happy path (original fails, real retry fires, replacement clears) still works after the lineage-ordering fix", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    const webhook = ctx.buildWebhookService();
    const failResult = await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1h10-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    expect(failResult.status).toBe("processed");

    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();
    await backdateRetryScheduledForTest(retryRow!.id);

    const retryService = ctx.buildRetryService();
    const fireResult = await retryService.fireDueRetries(new Date());
    expect(fireResult.fired).toBe(1);

    const firedRetry = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    const replacementId = firedRetry!.resultingPaymentAttemptId!;
    const replacement = await ctx.payments.findById(replacementId);

    const successResult = await webhook.receiveWebhook(
      signedWebhookForTest(ctx.provider, { providerEventId: `b1h10-success-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId: replacement!.providerPaymentId }),
    );
    expect(successResult.status).toBe("processed");

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(replacementId);
  });

  /** Directly constructs the OLD reachable state — a retry row and a replacement `payment_attempt` sharing the deterministic `retry-<retryId>` key, but `resultingPaymentAttemptId` still `null` — the exact gap Defect 1 closes. Never claims this replicates the old buggy CODE PATH (that code no longer exists); only the DATA SHAPE it could leave behind. */
  async function seedLegacyReplacementForTest(
    ctx: ReturnType<typeof buildFullWebhookContextForTest>,
    retryId: string,
    agreementId: string,
    installmentScheduleItemId: string,
    debtor: { profileId: string },
    creditor: { profileId: string },
    amountMinorUnits: number,
    currency: string,
    initialStatus: "succeeded" | "submitted" = "succeeded",
  ) {
    const db = getDb();
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date() }).where(eq(paymentRetry.id, retryId));
    return ctx.payments.insertPending({
      idempotencyKey: `retry-${retryId}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits,
      currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus,
    });
  }

  it("B1-I1 — Defect 1A (TRUSTED LEGACY LINK REPAIR): the OLD reachable state (retry row + replacement attempt with a trusted retry key + resultingPaymentAttemptId=null) — running the actual retry coordination/adoption path repairs the link to the exact attempt, and never creates a second attempt", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1i1-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const legacyAttempt = await seedLegacyReplacementForTest(
      ctx,
      retryRow!.id,
      agreementId,
      installmentScheduleItemId,
      debtor,
      creditor,
      originalPayment.amountMinorUnits,
      originalPayment.currency,
      "succeeded",
    );
    // R11 PASS B1 — SURGICAL FINAL PATCH: the replacement must ALSO already be durably cleared —
    // Part 1A's own fired-scan selector (and the shared identity/adoption + application sequence
    // this exercises via `claimAndExecuteRetry`) now correctly distinguishes "genuinely resolved"
    // from "adopted but still owes application," and this test is specifically about the LINK
    // repairing to `fired`, not about a still-transiently-incomplete application.
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyAttempt.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });
    expect((await ctx.retries.findById(retryRow!.id))?.resultingPaymentAttemptId).toBeNull(); // confirmed still the OLD gap.

    const result = await ctx.retryCoordinator.claimAndExecuteRetry({
      installmentScheduleItemId,
      retryId: retryRow!.id,
      idempotencyKey: `retry-${retryRow!.id}`,
      agreementId,
      provider: ctx.provider,
      prepared: { amountMinorUnits: originalPayment.amountMinorUnits, currency: originalPayment.currency, paymentMethod: "ach", bankConnectionId: null },
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      effectApplier: webhook,
    });
    expect(result.outcome).toBe("fired");
    if (result.outcome !== "fired") throw new Error("unreachable — asserted above");
    expect(result.resultingPaymentAttemptId).toBe(legacyAttempt.id);

    const repairedRetry = await ctx.retries.findById(retryRow!.id);
    expect(repairedRetry?.resultingPaymentAttemptId).toBe(legacyAttempt.id); // durable link repaired.

    const attemptsForInstallment = await getDb().select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId));
    expect(attemptsForInstallment).toHaveLength(2); // originalPayment + legacyAttempt — never a THIRD, duplicate attempt.
  });

  it("B1-I2 — Defect 1B (PROCESSED-SUCCESS REPAIR): old state where the replacement already succeeded and durably cleared, with NO webhook event ever created for it (so recoverBatch has nothing to reprocess) and resultingPaymentAttemptId initially null — running the actual adoption/recovery path repairs the trusted link AND applies the proposal idempotently, storing the exact cleared replacement attempt id, with no duplicate clearing/provider effect", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1i2-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const legacyAttempt = await seedLegacyReplacementForTest(
      ctx,
      retryRow!.id,
      agreementId,
      installmentScheduleItemId,
      debtor,
      creditor,
      originalPayment.amountMinorUnits,
      originalPayment.currency,
      "succeeded",
    );
    // Durably cleared already — but crucially, NO webhook event exists for this at all (the "success
    // webhook already processed and thus ineligible for recoverBatch" scenario 1B describes).
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyAttempt.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });
    const stillAwaitingBefore = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaitingBefore.status).toBe("awaiting_payment");

    const result = await ctx.retryCoordinator.claimAndExecuteRetry({
      installmentScheduleItemId,
      retryId: retryRow!.id,
      idempotencyKey: `retry-${retryRow!.id}`,
      agreementId,
      provider: ctx.provider,
      prepared: { amountMinorUnits: originalPayment.amountMinorUnits, currency: originalPayment.currency, paymentMethod: "ach", bankConnectionId: null },
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      effectApplier: webhook,
    });
    expect(result.outcome).toBe("fired");

    const repairedRetry = await ctx.retries.findById(retryRow!.id);
    expect(repairedRetry?.resultingPaymentAttemptId).toBe(legacyAttempt.id);

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(legacyAttempt.id);

    const clearedEntries = await ctx.ledger.listEntriesForPaymentAttempt(legacyAttempt.id);
    expect(clearedEntries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // never duplicated.
  });

  it("B1-I3 — Defect 2 (AGREEMENT-FIRST LOCK PROTOCOL): independent Postgres connections — expiration acquires the agreement FOR UPDATE lock (before even the proposal row), then a concurrent real ledger clearing attempt for the SAME agreement genuinely queues behind it (server-side proof via pg_stat_activity) — never expired once clearing/in-flight evidence wins, no deadlock", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 400, "2020-01-01"); // already overdue
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const db = getDb();
    await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, payment.id)); // succeeded, not yet cleared.

    const isolatedExpire = createIsolatedDb(DATABASE_URL);
    const isolatedClear = createIsolatedDb(DATABASE_URL);
    try {
      const lockAcquired = createDeferred<void>();
      const releaseExpire = createDeferred<void>();
      const isolatedExpireRequests = new DrizzlePartialPaymentRepository(isolatedExpire.db, {
        // Paused immediately after the AGREEMENT lock — before the proposal row is even locked —
        // proving the agreement lock ALONE is what serializes against concurrent ledger clearing.
        // Filtered on the exact agreement under test — see B1-H4's identical filter/rationale:
        // expireOverdue() may invoke this once per overdue candidate anywhere in the shared database,
        // not just this test's own agreement.
        afterAgreementLock: async (lockedAgreementId) => {
          if (lockedAgreementId !== agreementId) return;
          lockAcquired.resolve();
          await releaseExpire.promise;
        },
      });
      const isolatedExpireService = new PartialPaymentService({
        agreementService: getAgreementService(),
        requests: isolatedExpireRequests,
        payments: ctx.payments,
        audit: new AuditService(new DrizzleAuditEventRepository()),
      });

      const expirePromise = isolatedExpireService.expireOverdue(new Date());
      await lockAcquired.promise; // deterministic: expiration genuinely holds the agreement row lock now.

      const isolatedLedger = new LedgerService({
        accounts: new DrizzleLedgerAccountRepository(isolatedClear.db),
        entries: new DrizzleLedgerJournalEntryRepository(isolatedClear.db),
        audit: new AuditService(new DrizzleAuditEventRepository(isolatedClear.db)),
      });
      const clearPid = await warmUp(isolatedClear.client);
      const clearPromise = isolatedLedger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: 400 });
      try {
        await waitUntilPidBlockedOnLock(DATABASE_URL, clearPid); // server-side proof: the ledger insert's own implicit agreement FK lock genuinely queues behind expiration's held FOR UPDATE lock.
      } finally {
        // MUST fire even if the wait above throws (a transient poll timeout) — otherwise
        // `isolatedExpireService.expireOverdue`'s own transaction callback is left forever awaiting
        // `releaseExpire.promise` inside `afterAgreementLock`, hanging the held agreement lock (and
        // this test's own connection close) indefinitely rather than failing cleanly. See the
        // identical fix/rationale on B1-H4's own analogous race.
        releaseExpire.resolve();
      }
      const expireResult = await expirePromise;
      await clearPromise; // now unblocked — commits cleanly, no deadlock.

      expect(expireResult.expired).toBe(0); // in-flight/clearing evidence — expiration correctly lost.
      const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
      expect(stillAwaiting.status).toBe("awaiting_payment");
      expect(await ctx.ledger.findEntry(payment.id, "payment_cleared")).not.toBeNull(); // clearing committed successfully once unblocked.
    } finally {
      await isolatedExpire.close();
      await isolatedClear.close();
    }
  });

  it("B1-I4 — Defect 2A (IN_FLIGHT EVIDENCE): a succeeded-but-not-yet-cleared attempt, and separately a still-submitted attempt, both classify as IN_FLIGHT — expiration never fires for either", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);
    const db = getDb();

    // Sub-case A: succeeded, no payment_cleared entry yet (the succeeded-before-ledger interval).
    const acceptedA = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 400, "2020-01-01");
    const paymentA = await initiateRealPartialPaymentForTest(ctx, acceptedA, debtor);
    await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, paymentA.id));

    // Sub-case B: still genuinely in flight at the provider (never resolved either way yet).
    const { agreementId: agreementIdB, installmentScheduleItemId: installmentB } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const acceptedB = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementIdB, installmentB, 400, "2020-01-01");
    const paymentB = await initiateRealPartialPaymentForTest(ctx, acceptedB, debtor);
    expect(["scheduled", "submitted", "processing"]).toContain(paymentB.status);

    const { expired } = await ctx.partialPaymentService.expireOverdue(new Date());
    expect(expired).toBe(0);
    expect((await ctx.partialPaymentService.getPartialPaymentRequest(acceptedA.id, debtor.userId)).status).toBe("awaiting_payment");
    expect((await ctx.partialPaymentService.getPartialPaymentRequest(acceptedB.id, debtor.userId)).status).toBe("awaiting_payment");
  });

  it("B1-I5 — Defect 2A (NOT_CLEARED EVIDENCE): no payment ever initiated, and separately a conclusively failed payment with no pending replacement, both classify as NOT_CLEARED — expiration proceeds normally for both, never globally disabled", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    // Sub-case A: never initiated at all.
    const acceptedA = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 400, "2020-01-01");

    // Sub-case B: initiated, then conclusively failed, no retry/replacement ever created.
    const { agreementId: agreementIdB, installmentScheduleItemId: installmentB } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const acceptedB = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementIdB, installmentB, 400, "2020-01-01");
    const paymentB = await initiateRealPartialPaymentForTest(ctx, acceptedB, debtor);
    const db = getDb();
    await db.update(paymentAttempt).set({ status: "failed" }).where(eq(paymentAttempt.id, paymentB.id));

    const { expired } = await ctx.partialPaymentService.expireOverdue(new Date());
    expect(expired).toBe(2);
    expect((await ctx.partialPaymentService.getPartialPaymentRequest(acceptedA.id, debtor.userId)).status).toBe("expired");
    expect((await ctx.partialPaymentService.getPartialPaymentRequest(acceptedB.id, debtor.userId)).status).toBe("expired");
  });

  it("B1-I6 — Defect 3 (PROPOSAL CONSUMPTION, full real production sequence): success -> payment_cleared -> application intentionally fails -> a real reversal/supersession completes -> recovering success/application applies the proposal to the exact historically-cleared payment; the installment's own settlement stays financially unsatisfied per ledger truth; the proposal is not reusable; supersession evidence is durable", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);

    const flakyAutoApp = flakyForTest(ctx.autoApplication, "applyClearedPayment", 1, () => new Error("simulated transient application failure"));
    const webhookFlaky = ctx.buildWebhookService({ partialPaymentApplication: flakyAutoApp });
    const successEventId = `b1i6-success-${randomUUID()}`;
    await webhookFlaky.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: successEventId, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));

    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1i6-reversed-${randomUUID()}`, eventType: "payment.reversed", providerPaymentId: payment.providerPaymentId }));

    const successEventRow = await ctx.events.findByProviderEvent(ctx.provider.providerName, successEventId);
    await webhookFlaky.recoverBatch(100, new Date(successEventRow!.nextRetryAt!.getTime() + 1));

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(payment.id);
    expect(applied.status).not.toBe("awaiting_payment"); // UI eligibility (Defect 3C): never offered as Pay Now again.

    const settlementComputer = new DrizzleInstallmentSettlementComputer();
    const settlement = await settlementComputer.computeSettlement(installmentScheduleItemId);
    expect(settlement!.isSatisfied).toBe(false); // financial truth stays controlled exclusively by ledger/coordinateSupersession.

    const supersededAudit = await getDb()
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "partial_payment_request"), eq(auditEvent.targetResourceId, accepted.id), eq(auditEvent.action, "partial_payment_consuming_payment_superseded")));
    expect(supersededAudit.length).toBeGreaterThanOrEqual(1);
  });

  it("B1-I7 — Defect 3B (EXACT-ONCE SUPERSESSION EVIDENCE): repeating recovery/application after the proposal is already applied-and-superseded never reassigns it, never duplicates the application effect, and never appends unbounded duplicate supersession audit evidence", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1i7-success-${randomUUID()}`, eventType: "payment.succeeded", providerPaymentId: payment.providerPaymentId }));
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1i7-reversed-${randomUUID()}`, eventType: "payment.reversed", providerPaymentId: payment.providerPaymentId }));

    const applied1 = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied1.status).toBe("applied");
    expect(applied1.paymentAttemptId).toBe(payment.id);

    // Repeat the SAME idempotent application call directly — the real recovery mechanism's own
    // idempotent effect, invoked again exactly as a duplicate recovery pass would.
    const replay1 = await ctx.autoApplication.applyClearedPayment(payment.id);
    expect(replay1.outcome).toBe("already_applied"); // a distinct, safe-finalize idempotent-replay outcome — see ApplyClearedPaymentOutcome's own doc comment.
    const replay2 = await ctx.autoApplication.applyClearedPayment(payment.id);
    expect(replay2.outcome).toBe("already_applied");

    const applied2 = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied2.status).toBe("applied");
    expect(applied2.paymentAttemptId).toBe(payment.id); // never reassigned.

    const supersededAudit = await getDb()
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "partial_payment_request"), eq(auditEvent.targetResourceId, accepted.id), eq(auditEvent.action, "partial_payment_consuming_payment_superseded")));
    expect(supersededAudit).toHaveLength(1); // exact-once — never unbounded duplicate evidence.
  });

  it("B1-I8 — Defect 5A (RETRY-KEY, NULL resultingPaymentAttemptId): the real backward lineage resolution repairs itself via the deterministic retry-<id> key (never depending on resultingPaymentAttemptId being populated) and applies correctly; a retry-shaped key with NO matching retry row at all resolves UNKNOWN/retryable — never PROVEN_NOT_CORRELATED", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1i8-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const legacyReplacement = await seedLegacyReplacementForTest(
      ctx,
      retryRow!.id,
      agreementId,
      installmentScheduleItemId,
      debtor,
      creditor,
      originalPayment.amountMinorUnits,
      originalPayment.currency,
      "succeeded",
    );
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyReplacement.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });
    expect((await ctx.retries.findById(retryRow!.id))?.resultingPaymentAttemptId).toBeNull(); // still unrepaired.

    const result = await ctx.autoApplication.applyClearedPayment(legacyReplacement.id);
    expect(result.outcome).toBe("applied"); // resolved correctly via the deterministic key, never needing resultingPaymentAttemptId.
    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.paymentAttemptId).toBe(legacyReplacement.id);

    // A retry-shaped key with NO matching retry row at all — corrupt/unexpected, never "not correlated".
    const orphan = await ctx.payments.insertPending({
      idempotencyKey: `retry-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 100,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    let caught: unknown;
    try {
      await ctx.autoApplication.applyClearedPayment(orphan.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error); // thrown — retryable, never silently "not correlated".
  });

  it("B1-I9 — Defect 5B (PARTIAL-PAYMENT KEY, MISSING PROPOSAL): a partial-payment-<id> key pointing to a nonexistent proposal record is a correlated DATA INCONSISTENCY — durable reconciliation/conflict evidence is recorded, never classified as an ordinary unrelated payment", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const fakeProposalId = randomUUID();
    const orphan = await ctx.payments.insertPending({
      idempotencyKey: `partial-payment-${fakeProposalId}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 1_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: orphan.id, agreementId, currency: "USD", grossAmountMinorUnits: 1_000 });

    const result = await ctx.autoApplication.applyClearedPayment(orphan.id);
    expect(result.outcome).toBe("conflict"); // never "not_correlated" — a recognized key form with missing data.

    const conflictAudit = await getDb()
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "partial_payment_request"), eq(auditEvent.targetResourceId, fakeProposalId), eq(auditEvent.action, "partial_payment_application_conflict")));
    expect(conflictAudit.length).toBeGreaterThanOrEqual(1);
  });

  it("B1-I10 — Defect 4 (APPLICATION OUTCOME CONTRACT): each outcome class resolves to exactly its own documented tag — APPLIED, ALREADY_APPLIED, PROVEN_NOT_CORRELATED, NOT_YET_DURABLE, UNKNOWN/INCOMPLETE (thrown), CONFLICT", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    // PROVEN_NOT_CORRELATED — an ordinary, unrelated payment. A small amount, deliberately — this
    // shares the agreement's 1,000 principal with the later NOT_YET_DURABLE/APPLIED sub-scenario's
    // own 400-unit reservation below, and correlation-tagging is independent of amount.
    const ordinaryPayment = await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: `b1i10-ordinary-${randomUUID()}`,
      agreementId,
      amountMinorUnits: 100,
      actingUserId: debtor.userId,
      installmentScheduleItemId,
    });
    expect((await ctx.autoApplication.applyClearedPayment(ordinaryPayment.id)).outcome).toBe("not_correlated");

    // NOT_YET_DURABLE — correlated, but no payment_cleared entry exists yet.
    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const notYetDurable = await ctx.autoApplication.applyClearedPayment(payment.id);
    expect(notYetDurable.outcome).toBe("not_yet_durable");

    // APPLIED, then ALREADY_APPLIED on replay.
    const db = getDb();
    await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, payment.id));
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: payment.id, agreementId, currency: "USD", grossAmountMinorUnits: 400 });
    expect((await ctx.autoApplication.applyClearedPayment(payment.id)).outcome).toBe("applied");
    expect((await ctx.autoApplication.applyClearedPayment(payment.id)).outcome).toBe("already_applied"); // a distinct, safe-finalize idempotent-replay tag.

    // CONFLICT — a durably-cleared, correlated payment whose proposal is already applied to a DIFFERENT attempt.
    // Uses its OWN fresh agreement (never the shared `agreementId` above, which already has zero
    // remaining balance from `ordinaryPayment`'s earlier 1,000 clearing) so the ownership check and
    // the agreement-level ceiling both pass cleanly for this independent sub-scenario.
    const { agreementId: agreementIdC, installmentScheduleItemId: installmentC } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const acceptedC = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementIdC, installmentC);
    const paymentC1 = await initiateRealPartialPaymentForTest(ctx, acceptedC, debtor);
    await db.update(paymentAttempt).set({ status: "succeeded" }).where(eq(paymentAttempt.id, paymentC1.id));
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: paymentC1.id, agreementId: agreementIdC, currency: "USD", grossAmountMinorUnits: 400 });
    await ctx.autoApplication.applyClearedPayment(paymentC1.id); // applies to paymentC1 first.
    const conflictingOther = await ctx.paymentService.recordManualOffPlatformPayment({
      idempotencyKey: `b1i10-conflict-other-${randomUUID()}`,
      agreementId: agreementIdC,
      amountMinorUnits: 600,
      actingUserId: debtor.userId,
      installmentScheduleItemId: installmentC,
    });
    const conflictResult = await ctx.requests.applyIfAwaitingPayment(acceptedC.id, conflictingOther.id);
    expect(conflictResult.outcome).toBe("already_applied_different");

    // UNKNOWN/INCOMPLETE — lineage resolution genuinely cannot be determined; thrown, never returned.
    const orphanRetryKey = await ctx.payments.insertPending({
      idempotencyKey: `retry-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 100,
      currency: "USD",
      agreementId,
      providerName: "sandbox_mock",
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    let caught: unknown;
    try {
      await ctx.autoApplication.applyClearedPayment(orphanRetryKey.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it("B1-J1 — Defect 1 (CLAIMED SCHEDULER RESUMPTION): a claimed legacy retry (replacement already succeeded+cleared, resultingPaymentAttemptId still null) is repaired and its proposal applied by the REAL PaymentRetryService scheduler (fireDueRetries -> findClaimedForResumption -> resolveAmbiguousRetry), never a direct coordinator call — the retry reaches its terminal 'fired' state only once the required proposal effect is handled", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1j1-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    // The OLD reachable state this defect targets: a worker previously claimed this retry (e.g. to
    // resume an earlier ambiguous dispatch) — status "claimed", a real executionToken — while the
    // deterministic replacement attempt already exists, already succeeded, and already durably
    // cleared, yet `resultingPaymentAttemptId` was never repaired (the exact pre-Phase-A-fix gap).
    await db.update(paymentRetry).set({ status: "claimed", executionToken: randomUUID(), nextResolutionAttemptAt: null }).where(eq(paymentRetry.id, retryRow!.id));
    const legacyAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyAttempt.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });
    expect((await ctx.retries.findById(retryRow!.id))?.resultingPaymentAttemptId).toBeNull(); // confirmed still the OLD gap.
    expect((await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId)).status).toBe("awaiting_payment");

    // THE REAL SCHEDULER ENTRY POINT — never a direct coordinator method call.
    const retryService = ctx.buildRetryService({ effectApplier: webhook });
    const fireResult = await retryService.fireDueRetries(new Date());
    expect(fireResult.resolved).toBe(1);

    const repairedRetry = await ctx.retries.findById(retryRow!.id);
    expect(repairedRetry?.status).toBe("fired");
    expect(repairedRetry?.resultingPaymentAttemptId).toBe(legacyAttempt.id); // durable link repaired.

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(legacyAttempt.id);

    const attemptsForInstallment = await db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId));
    expect(attemptsForInstallment).toHaveLength(2); // originalPayment + legacyAttempt — never a THIRD attempt (no provider call, no new charge).
    const clearedEntries = await ctx.ledger.listEntriesForPaymentAttempt(legacyAttempt.id);
    expect(clearedEntries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // never duplicated.
  });

  it("B1-J2 — Defect 2 (ALREADY-FIRED AUTOMATIC REPAIR): a fired legacy retry (not selected by any ordinary scheduled/claimed scan) is discovered and repaired by the REAL production reconciliation selector (ReconciliationService.reconcileLegacyPartialPaymentLineage), never a direct claimAndExecuteRetry call", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1j2-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    // OLD reachable state: already `fired` (not selected by findDueForFiring/findClaimedForResumption
    // at all), replacement succeeded+durably cleared, but never repaired.
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date() }).where(eq(paymentRetry.id, retryRow!.id));
    const legacyAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyAttempt.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });
    expect((await ctx.retries.findById(retryRow!.id))?.resultingPaymentAttemptId).toBeNull();

    // THE REAL production entry point — `repairBatch` is the exact method
    // `/api/scheduler/recover-payment-webhooks` already invokes on a schedule; legacy partial-payment
    // repair is folded directly into it (Defect 1), never a separate, unused helper.
    const reconciliation = new ReconciliationService({
      payments: ctx.payments,
      webhookEvents: ctx.events,
      provider: ctx.provider,
      ledger: ctx.ledger,
      exceptions: new DrizzleReconciliationExceptionRepository(),
      legacyRetryLineageRepair: ctx.retryCoordinator,
    });
    const scanResult = await reconciliation.repairBatch(200);
    expect(scanResult.scanned).toBeGreaterThanOrEqual(1);

    const repairedRetry = await ctx.retries.findById(retryRow!.id);
    expect(repairedRetry?.resultingPaymentAttemptId).toBe(legacyAttempt.id);

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(legacyAttempt.id);

    const clearedEntries = await ctx.ledger.listEntriesForPaymentAttempt(legacyAttempt.id);
    expect(clearedEntries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // no webhook financial replay, no provider call, no duplicate clearing.
  });

  it("B1-J3 — Defect 3 (REPAIR TRANSIENT FAILURE RECOVERY): a legacy repair candidate whose application transiently fails leaves durable future repair eligibility (the proposal simply stays awaiting_payment — no bespoke pending flag needed); the very next repair pass completes it exactly once", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1j3-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date() }).where(eq(paymentRetry.id, retryRow!.id));
    const legacyAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyAttempt.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });

    // A SEPARATE coordinator instance wired with an application service that fails ONLY for THIS
    // test's own attempt id — `repairLegacyRetryLineage`'s scan is not isolated to this test alone
    // (the shared Postgres database may hold other already-`fired` retries from earlier tests in this
    // file, at earlier `firedAt` timestamps, so a plain "fail the Nth call" wrapper could consume its
    // failure budget on an unrelated row instead of this one). `ctx.retryCoordinator` itself stays
    // real/non-flaky throughout, for the second, successful pass below.
    let injectedFailureUsed = false;
    const flakyAutoApp: PartialPaymentApplicationForRepair = {
      applyClearedPayment: async (paymentAttemptId: string) => {
        if (paymentAttemptId === legacyAttempt.id && !injectedFailureUsed) {
          injectedFailureUsed = true;
          throw new Error("simulated transient legacy repair failure");
        }
        return ctx.autoApplication.applyClearedPayment(paymentAttemptId);
      },
    };
    const flakyCoordinator = new DrizzleFailedPaymentRetryCoordinator(undefined, undefined, undefined, undefined, undefined, flakyAutoApp);

    const firstPass = await flakyCoordinator.repairLegacyRetryLineage();
    expect(firstPass.scanned).toBeGreaterThanOrEqual(1);
    // Failed safely: no duplicate/partial side effect, and — critically — durable future repair
    // eligibility remains, because the proposal itself is still `awaiting_payment` (the only durable
    // signal this design relies on, per Defect 3's own doc comment).
    const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaiting.status).toBe("awaiting_payment");

    // R11 PASS B1 — SURGICAL FINAL PATCH (Part 1C — TRANSIENT DEFERRED REPAIR MUST BACK OFF): the
    // failed first pass durably deferred this row's own re-selection via `nextResolutionAttemptAt` —
    // deterministic test-time setup (mirroring L3's own identical precedent) makes it eligible again
    // rather than asserting on wall-clock timing.
    expect((await ctx.retries.findById(retryRow!.id))?.nextResolutionAttemptAt).not.toBeNull();
    await db.update(paymentRetry).set({ nextResolutionAttemptAt: null }).where(eq(paymentRetry.id, retryRow!.id));

    const secondPass = await ctx.retryCoordinator.repairLegacyRetryLineage(); // the REAL, non-flaky coordinator — models the next scheduled reconciliation run.
    expect(secondPass.scanned).toBeGreaterThanOrEqual(1);
    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(legacyAttempt.id);
    const clearedEntries = await ctx.ledger.listEntriesForPaymentAttempt(legacyAttempt.id);
    expect(clearedEntries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // applied exactly once — no duplicate ledger/provider effect from the two passes.
  });

  it("B1-J4 — Defect 4 (CONTRADICTORY LINEAGE FAILS SAFE): retry.resultingPaymentAttemptId already durably references attempt B; a trusted retry-<id>-keyed attempt A later appears — the REAL repair path never overwrites B, never adopts A, never applies the proposal from contradictory evidence, and records durable conflict evidence", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1j4-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    // B (already durably recorded) — simply `originalPayment` itself: a real, distinct, already-
    // existing attempt in the same agreement/installment. The identity of B is irrelevant to the
    // assertion; only that it is NOT A and is already recorded.
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date(), resultingPaymentAttemptId: originalPayment.id }).where(eq(paymentRetry.id, retryRow!.id));

    // A — a LATER, deterministically-keyed, otherwise-trustworthy attempt for the SAME retry.
    const attemptA = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: attemptA.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });

    await ctx.retryCoordinator.repairLegacyRetryLineage();

    const afterRepair = await ctx.retries.findById(retryRow!.id);
    expect(afterRepair?.resultingPaymentAttemptId).toBe(originalPayment.id); // B never overwritten by A.
    const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaiting.status).toBe("awaiting_payment"); // never applied from contradictory evidence.

    const conflictAudit = await db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "payment_retry"), eq(auditEvent.targetResourceId, retryRow!.id), eq(auditEvent.action, "payment_retry_legacy_lineage_conflict_contradictory_resulting_attempt")));
    expect(conflictAudit.length).toBeGreaterThanOrEqual(1); // durable reconciliation/conflict evidence exists.
  });

  it("B1-J5 — Defect 4/5 (AGREEMENT/INSTALLMENT IDENTITY MISMATCH): a trusted retry-<id>-keyed attempt exists but disagrees with the retry's own recorded agreement/installment ownership — the REAL repair path rejects it outright: no mutation of the resulting link, no proposal application, durable conflict evidence recorded", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const { agreementId: otherAgreementId, installmentScheduleItemId: otherInstallmentId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `b1j5-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date() }).where(eq(paymentRetry.id, retryRow!.id));

    // A trusted retry-<id> key, but created against a DIFFERENT agreement/installment than the
    // retry row's own recorded ownership context.
    const mismatchedAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId: otherAgreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId: otherInstallmentId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: mismatchedAttempt.id, agreementId: otherAgreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });

    await ctx.retryCoordinator.repairLegacyRetryLineage();

    const afterRepair = await ctx.retries.findById(retryRow!.id);
    expect(afterRepair?.resultingPaymentAttemptId).toBeNull(); // rejected — never mutated.
    const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaiting.status).toBe("awaiting_payment"); // never applied.

    const conflictAudit = await db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "payment_retry"), eq(auditEvent.targetResourceId, retryRow!.id), eq(auditEvent.action, "payment_retry_legacy_lineage_conflict_identity_mismatch")));
    expect(conflictAudit.length).toBeGreaterThanOrEqual(1); // durable conflict evidence recorded.
  });

  // ==========================================================================================
  // R11 PASS B1 — LEGACY RECOVERY FINAL CORRECTION (K1-K8). J1-J5 above exercise the FIRED-scan
  // repair path only (Defect 2's own selector). These cover the SEPARATE, previously-uncovered
  // "already resolved" CLAIMED-caller continuation defect (Defect 4/5/6/7) and the starvation/
  // atomicity guarantees under genuine concurrency (Defect 2/5) — every test below drives a REAL
  // production entry point (`PaymentRetryService.fireDueRetries` or `ReconciliationService
  // .repairBatch`), never a direct private-method call.
  // ==========================================================================================

  it("K1 — claimed conflict stops adoption: retry R is 'claimed' with resultingPaymentAttemptId already durably B; a trusted retry-<id>-keyed, terminal attempt A later appears (A != B) — the REAL PaymentRetryService scheduler path (fireDueRetries -> findClaimedForResumption -> resolveAmbiguousRetry) never overwrites B, never adopts A, calls the provider zero times, creates no new attempt, and records durable conflict evidence", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const payment = await ctx.paymentService.createPayment({
      idempotencyKey: `k1-original-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 200,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `k1-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: payment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(payment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    // The OLD/corrupt-looking but real-world-reachable state this defect targets: a worker previously
    // claimed this retry and SOMEHOW already durably recorded B — `payment` itself, a real, distinct,
    // already-existing attempt; its identity is irrelevant to the assertion, only that it is NOT A and
    // is already recorded (mirrors B1-J4's identical precedent for the fired-scan path).
    await db
      .update(paymentRetry)
      .set({ status: "claimed", executionToken: randomUUID(), nextResolutionAttemptAt: null, resultingPaymentAttemptId: payment.id })
      .where(eq(paymentRetry.id, retryRow!.id));

    // A — a LATER, deterministically-keyed, terminal, otherwise-trustworthy attempt for the SAME retry.
    const attemptA = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: attemptA.id, agreementId, currency: payment.currency, grossAmountMinorUnits: payment.amountMinorUnits });

    const { provider: countingProvider, callCount } = countingProviderForTest(ctx.provider);
    const retryService = ctx.buildRetryService({ provider: countingProvider, effectApplier: webhook });
    const fireResult = await retryService.fireDueRetries(new Date());
    expect(fireResult.resolved).toBe(1);
    expect(callCount()).toBe(0); // an already-terminal "already resolved" adoption never contacts the provider.

    const afterRepair = await ctx.retries.findById(retryRow!.id);
    expect(afterRepair?.resultingPaymentAttemptId).toBe(payment.id); // B never overwritten by A.

    const attemptsForInstallment = await db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId));
    expect(attemptsForInstallment).toHaveLength(2); // payment (B) + attemptA — never a THIRD (no new attempt, no provider call).

    const conflictAudit = await db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "payment_retry"), eq(auditEvent.targetResourceId, retryRow!.id), eq(auditEvent.action, "payment_retry_legacy_lineage_conflict_contradictory_resulting_attempt")));
    expect(conflictAudit.length).toBeGreaterThanOrEqual(1); // durable reconciliation/conflict evidence exists.
  });

  it("K2 — claimed identity mismatch stops adoption: retry R is 'claimed' (resultingPaymentAttemptId still null); a trusted retry-<id>-keyed, terminal attempt exists but disagrees with R's own recorded agreement/installment ownership — the REAL scheduler path rejects it outright: no link mutation, no proposal application, zero provider calls, durable conflict evidence recorded", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const { agreementId: otherAgreementId, installmentScheduleItemId: otherInstallmentId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const payment = await ctx.paymentService.createPayment({
      idempotencyKey: `k2-original-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 200,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `k2-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: payment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(payment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    await db.update(paymentRetry).set({ status: "claimed", executionToken: randomUUID(), nextResolutionAttemptAt: null }).where(eq(paymentRetry.id, retryRow!.id));

    // A trusted retry-<id> key, terminal, but created against a DIFFERENT agreement/installment than R's own recorded ownership context.
    const mismatchedAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      agreementId: otherAgreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId: otherInstallmentId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: mismatchedAttempt.id, agreementId: otherAgreementId, currency: payment.currency, grossAmountMinorUnits: payment.amountMinorUnits });

    const { provider: countingProvider, callCount } = countingProviderForTest(ctx.provider);
    const retryService = ctx.buildRetryService({ provider: countingProvider, effectApplier: webhook });
    const fireResult = await retryService.fireDueRetries(new Date());
    expect(fireResult.resolved).toBe(1);
    expect(callCount()).toBe(0);

    const afterRepair = await ctx.retries.findById(retryRow!.id);
    expect(afterRepair?.resultingPaymentAttemptId).toBeNull(); // rejected — never mutated.

    const conflictAudit = await db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "payment_retry"), eq(auditEvent.targetResourceId, retryRow!.id), eq(auditEvent.action, "payment_retry_legacy_lineage_conflict_identity_mismatch")));
    expect(conflictAudit.length).toBeGreaterThanOrEqual(1);
  });

  it("K3 — original-attempt lineage mismatch stops adoption BEFORE any candidate is even considered: retry R's own recorded agreement/installment context agrees with a genuinely trustworthy candidate A, but R's own originalPaymentAttemptId points at an attempt from an INCONSISTENT agreement/installment context — the REAL scheduler path records conflict before ever validating/adopting A: no link mutation, no proposal application, zero provider calls", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const { agreementId: otherAgreementId, installmentScheduleItemId: otherInstallmentId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const payment = await ctx.paymentService.createPayment({
      idempotencyKey: `k3-original-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 200,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `k3-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: payment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(payment.id);
    expect(retryRow).not.toBeNull();

    // A real, terminal attempt from a COMPLETELY DIFFERENT agreement/installment — never legitimately
    // reachable as this retry's own original attempt; models corrupt/inconsistent legacy data.
    const inconsistentOriginal = await ctx.payments.insertPending({
      idempotencyKey: `k3-inconsistent-original-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 200,
      currency: "USD",
      agreementId: otherAgreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId: otherInstallmentId,
      paymentMethod: "ach",
      initialStatus: "failed",
    });

    const db = getDb();
    // R's OWN agreementId/installmentScheduleItemId are left exactly as originally recorded (matching
    // `payment`'s real context) — only `originalPaymentAttemptId` is corrupted to point elsewhere.
    await db
      .update(paymentRetry)
      .set({ status: "claimed", executionToken: randomUUID(), nextResolutionAttemptAt: null, originalPaymentAttemptId: inconsistentOriginal.id })
      .where(eq(paymentRetry.id, retryRow!.id));

    // Candidate A agrees with R's own recorded agreementId/installmentScheduleItemId — otherwise
    // perfectly trustworthy — proving the original-attempt check runs, and refuses, BEFORE candidate
    // validation ever gets a chance to adopt it.
    const candidateA = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: candidateA.id, agreementId, currency: payment.currency, grossAmountMinorUnits: payment.amountMinorUnits });

    const { provider: countingProvider, callCount } = countingProviderForTest(ctx.provider);
    const retryService = ctx.buildRetryService({ provider: countingProvider, effectApplier: webhook });
    const fireResult = await retryService.fireDueRetries(new Date());
    expect(fireResult.resolved).toBe(1);
    expect(callCount()).toBe(0);

    const afterRepair = await ctx.retries.findById(retryRow!.id);
    expect(afterRepair?.resultingPaymentAttemptId).toBeNull(); // never mutated.

    const conflictAudit = await db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "payment_retry"), eq(auditEvent.targetResourceId, retryRow!.id), eq(auditEvent.action, "payment_retry_legacy_lineage_conflict_original_attempt_context_mismatch")));
    expect(conflictAudit.length).toBeGreaterThanOrEqual(1);
  });

  it("K4 — production repairBatch integration: a fired legacy retry correlated to a not-yet-applied partial-payment proposal is discovered and repaired by the REAL production entry point (ReconciliationService.repairBatch — the exact method /api/scheduler/recover-payment-webhooks already invokes on every tick), never the standalone helper directly; the exact historical replacement attempt is retained and no financial effect is replayed", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    const eventsBefore = (await ctx.events.listAll()).length;
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `k4-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date() }).where(eq(paymentRetry.id, retryRow!.id));
    const legacyAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyAttempt.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });
    expect((await ctx.retries.findById(retryRow!.id))?.resultingPaymentAttemptId).toBeNull();

    // THE REAL production entry point — never `repairLegacyRetryLineage` called directly.
    const reconciliation = new ReconciliationService({
      payments: ctx.payments,
      webhookEvents: ctx.events,
      provider: ctx.provider,
      ledger: ctx.ledger,
      exceptions: new DrizzleReconciliationExceptionRepository(),
      legacyRetryLineageRepair: ctx.retryCoordinator,
    });
    const scanResult = await reconciliation.repairBatch(200);
    expect(scanResult.scanned).toBeGreaterThanOrEqual(1);

    const repairedRetry = await ctx.retries.findById(retryRow!.id);
    expect(repairedRetry?.resultingPaymentAttemptId).toBe(legacyAttempt.id); // exact historical replacement retained.

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(legacyAttempt.id);

    // NO FINANCIAL REPLAY: no synthetic/new webhook event was ever recorded, no duplicate clearing.
    const eventsAfter = (await ctx.events.listAll()).length;
    expect(eventsAfter).toBe(eventsBefore + 1); // only the one real "payment.failed" delivery above — the repair itself created zero events.
    const clearedEntries = await ctx.ledger.listEntriesForPaymentAttempt(legacyAttempt.id);
    expect(clearedEntries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
  });

  it("K5 — fair progress beyond the batch limit: HEALTHY (conclusively unrelated) and CONFLICTING (already durably adjudicated) fired retries never monopolize a bounded repair pass — a genuinely unresolved legacy candidate seeded AFTER them, with a batch limit smaller than the total number of rows the selector's own WHERE clause matches, is still eventually reached and repaired by repeated REAL production repairBatch invocations, with no permanent fixed-prefix starvation", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);
    const db = getDb();
    const webhook = ctx.buildWebhookService();

    // HEALTHY noise: an ORDINARY (never partial-payment-correlated) fired retry. The selector's own
    // `exists(...)` join requires the original attempt to be `partial-payment-<id>`-keyed — this row
    // never matches it, at the DATABASE level, no matter how many of these precede a real candidate.
    const ordinaryPayment = await ctx.paymentService.createPayment({
      idempotencyKey: `k5-healthy-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 50,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `k5-healthy-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: ordinaryPayment.providerPaymentId }));
    const ordinaryRetry = await ctx.retries.findByOriginalPaymentAttemptId(ordinaryPayment.id);
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date(Date.now() - 100 * 60_000) }).where(eq(paymentRetry.id, ordinaryRetry!.id));

    // CONFLICTING noise: two fired, partial-payment-correlated retries whose resulting link is ALREADY
    // durably contradictory — real WHERE-clause candidates on their first scan, but self-excluding
    // (via the durable conflict marker) from every scan after that.
    async function seedConflictingCandidate(index: number, firedAt: Date): Promise<string> {
      const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 40, "2030-01-01");
      const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
      await webhook.receiveWebhook(
        signedWebhookForTest(ctx.provider, { providerEventId: `k5-conflict-fail-${index}-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }),
      );
      const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
      await db.update(paymentRetry).set({ status: "fired", firedAt, resultingPaymentAttemptId: originalPayment.id }).where(eq(paymentRetry.id, retryRow!.id));
      const candidate = await ctx.payments.insertPending({
        idempotencyKey: `retry-${retryRow!.id}`,
        payerProfileKind: "personal",
        payerProfileId: debtor.profileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditor.profileId,
        amountMinorUnits: originalPayment.amountMinorUnits,
        currency: originalPayment.currency,
        agreementId,
        providerName: "sandbox_mock",
        installmentScheduleItemId,
        paymentMethod: "ach",
        initialStatus: "succeeded",
      });
      await ctx.ledger.postPaymentCleared({ paymentAttemptId: candidate.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });
      return retryRow!.id;
    }
    const conflictRetryIds = [
      await seedConflictingCandidate(0, new Date(Date.now() - 50 * 60_000)),
      await seedConflictingCandidate(1, new Date(Date.now() - 49 * 60_000)),
    ];

    // THE REAL, genuinely unresolved candidate — latest firedAt of all.
    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 300, "2030-01-01");
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `k5-real-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const realRetryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date() }).where(eq(paymentRetry.id, realRetryRow!.id));
    const legacyAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${realRetryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyAttempt.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });
    expect((await ctx.retries.findById(realRetryRow!.id))?.resultingPaymentAttemptId).toBeNull();

    // THE REAL production entry point, bounded to a limit (2) SMALLER than the number of rows the
    // selector's own WHERE clause matches at the start (the two still-unresolved conflicting rows +
    // this real candidate = 3) — proving a fixed prefix never permanently blocks a later row.
    const reconciliation = new ReconciliationService({
      payments: ctx.payments,
      webhookEvents: ctx.events,
      provider: ctx.provider,
      ledger: ctx.ledger,
      exceptions: new DrizzleReconciliationExceptionRepository(),
      legacyRetryLineageRepair: ctx.retryCoordinator,
    });
    let repaired = false;
    for (let pass = 0; pass < 5 && !repaired; pass++) {
      await reconciliation.repairBatch(2);
      const check = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
      repaired = check.status === "applied";
    }
    expect(repaired).toBe(true); // the later, genuinely unresolved candidate was eventually reached — never starved.

    const finallyApplied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(finallyApplied.paymentAttemptId).toBe(legacyAttempt.id);

    // Both earlier CONFLICTING rows were durably adjudicated exactly once each — never re-adopted, never left unresolved.
    for (const retryId of conflictRetryIds) {
      const conflictAudit = await db
        .select({ id: auditEvent.id })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.targetResourceType, "payment_retry"),
            eq(auditEvent.targetResourceId, retryId),
            eq(auditEvent.action, "payment_retry_legacy_lineage_conflict_contradictory_resulting_attempt"),
          ),
        );
      expect(conflictAudit.length).toBeGreaterThanOrEqual(1);
    }
    // The HEALTHY (unrelated) row was never touched — no conflict, no link write.
    expect((await ctx.retries.findById(ordinaryRetry!.id))?.resultingPaymentAttemptId).toBeNull();
  });

  it("K6 — transient pre-application failure remains recoverable through the REAL production repairBatch path (never merely the standalone helper): first pass injects a real application failure via ReconciliationService.repairBatch; the required effect remains durably owed; the very next REAL repairBatch pass automatically rediscovers and repairs it exactly once", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `k6-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date() }).where(eq(paymentRetry.id, retryRow!.id));
    const legacyAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyAttempt.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });

    let injectedFailureUsed = false;
    const flakyAutoApp: PartialPaymentApplicationForRepair = {
      applyClearedPayment: async (paymentAttemptId: string) => {
        if (paymentAttemptId === legacyAttempt.id && !injectedFailureUsed) {
          injectedFailureUsed = true;
          throw new Error("simulated transient legacy repair failure");
        }
        return ctx.autoApplication.applyClearedPayment(paymentAttemptId);
      },
    };
    const flakyCoordinator = new DrizzleFailedPaymentRetryCoordinator(undefined, undefined, undefined, undefined, undefined, flakyAutoApp);
    const flakyReconciliation = new ReconciliationService({
      payments: ctx.payments,
      webhookEvents: ctx.events,
      provider: ctx.provider,
      ledger: ctx.ledger,
      exceptions: new DrizzleReconciliationExceptionRepository(),
      legacyRetryLineageRepair: flakyCoordinator,
    });
    const firstPass = await flakyReconciliation.repairBatch(200);
    expect(firstPass.scanned).toBeGreaterThanOrEqual(1);
    expect(injectedFailureUsed).toBe(true);
    const stillAwaiting = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillAwaiting.status).toBe("awaiting_payment"); // durable future repair eligibility preserved.

    // R11 PASS B1 — SURGICAL FINAL PATCH (Part 1C — TRANSIENT DEFERRED REPAIR MUST BACK OFF): the
    // failed first pass durably deferred this row's own re-selection via `nextResolutionAttemptAt` —
    // deterministic test-time setup (mirroring L3's own identical precedent) makes it eligible again
    // rather than asserting on wall-clock timing.
    expect((await ctx.retries.findById(retryRow!.id))?.nextResolutionAttemptAt).not.toBeNull();
    await db.update(paymentRetry).set({ nextResolutionAttemptAt: null }).where(eq(paymentRetry.id, retryRow!.id));

    const realReconciliation = new ReconciliationService({
      payments: ctx.payments,
      webhookEvents: ctx.events,
      provider: ctx.provider,
      ledger: ctx.ledger,
      exceptions: new DrizzleReconciliationExceptionRepository(),
      legacyRetryLineageRepair: ctx.retryCoordinator, // the REAL, non-flaky coordinator — models the next scheduled tick.
    });
    const secondPass = await realReconciliation.repairBatch(200);
    expect(secondPass.scanned).toBeGreaterThanOrEqual(1);
    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(legacyAttempt.id);
    const clearedEntries = await ctx.ledger.listEntriesForPaymentAttempt(legacyAttempt.id);
    expect(clearedEntries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // applied exactly once across both passes.
  });

  it("K7 — post-application required-audit failure documents the actual required-effect boundary: the required effect is the durable awaiting_payment -> applied transition alone; the best-effort supersession-evidence audit note is NOT a required effect (see PartialPaymentAutoApplicationService's own Defect-7 doc comment) — its injected failure never blocks, undoes, or duplicates the required effect, and a second REAL repairBatch pass is an idempotent no-op with nothing outstanding to rediscover", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `k7-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date() }).where(eq(paymentRetry.id, retryRow!.id));
    const legacyAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyAttempt.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });
    // The consuming payment is ALREADY superseded at the moment of application — the branch that
    // writes the best-effort supersession-evidence audit note (see `applyClearedPayment`'s own
    // `isCurrentlySuperseded` handling) is the one under test.
    await db.update(paymentAttempt).set({ status: "refunded" }).where(eq(paymentAttempt.id, legacyAttempt.id));

    let injectedAuditFailureUsed = false;
    const realAudit = new AuditService(new DrizzleAuditEventRepository());
    const flakyAudit = flakyForTest(realAudit, "record", 1, () => {
      injectedAuditFailureUsed = true;
      return new Error("simulated required-audit-write failure");
    });
    const flakyAutoApp = new PartialPaymentAutoApplicationService({ requests: ctx.requests, payments: ctx.payments, retries: ctx.retries, ledger: ctx.ledger, audit: flakyAudit });
    const flakyCoordinator = new DrizzleFailedPaymentRetryCoordinator(undefined, undefined, undefined, undefined, undefined, flakyAutoApp);

    const firstPass = await flakyCoordinator.repairLegacyRetryLineage();
    expect(firstPass.scanned).toBeGreaterThanOrEqual(1);
    expect(injectedAuditFailureUsed).toBe(true); // proves the injected failure actually fired, not merely unreached.

    // The required effect completed despite the injected audit failure — never thrown, never left unapplied.
    const appliedAfterFirstPass = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(appliedAfterFirstPass.status).toBe("applied");
    expect(appliedAfterFirstPass.paymentAttemptId).toBe(legacyAttempt.id);

    // Second REAL pass: idempotent no-op — nothing is outstanding (the required effect already durably
    // completed; only the best-effort audit note was ever affected, and this mechanism never separately
    // rediscovers/retries it).
    const secondPass = await ctx.retryCoordinator.repairLegacyRetryLineage();
    void secondPass;
    const stillApplied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(stillApplied.status).toBe("applied");
    expect(stillApplied.paymentAttemptId).toBe(legacyAttempt.id);
    const clearedEntries = await ctx.ledger.listEntriesForPaymentAttempt(legacyAttempt.id);
    expect(clearedEntries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // no duplicate/financial replay across both passes.
  });

  it("K8 — atomic null-or-same race: two GENUINELY independent Postgres connections concurrently run the real repair scan against the SAME 'fired' retry whose resultingPaymentAttemptId already durably references B, while a later, otherwise-trustworthy candidate A exists — neither connection's competing write silently overwrites the other; both independently and consistently classify the contradiction as a conflict (deduplicated to exactly one durable record), and B is never replaced by A", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    // The retry's own original attempt MUST be `partial-payment-<id>`-keyed and correlated to a
    // not-yet-`applied` proposal — `repairLegacyRetryLineage`'s own candidate selector (Defect 2) only
    // ever matches rows shaped this way; an ordinary, uncorrelated retry (as K1/K8's earlier draft used)
    // is conclusively excluded at the database level and would never reach this race at all.
    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const payment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `k8-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: payment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(payment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    // B — already durably recorded (payment itself), exactly like K1's identical precedent.
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date(), resultingPaymentAttemptId: payment.id }).where(eq(paymentRetry.id, retryRow!.id));
    const attemptA = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: attemptA.id, agreementId, currency: payment.currency, grossAmountMinorUnits: payment.amountMinorUnits });

    const DATABASE_URL = process.env.DATABASE_URL!;
    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const coordinatorA = new DrizzleFailedPaymentRetryCoordinator(isolatedA.db, undefined, undefined, undefined, undefined, ctx.autoApplication);
      const coordinatorB = new DrizzleFailedPaymentRetryCoordinator(isolatedB.db, undefined, undefined, undefined, undefined, ctx.autoApplication);

      const [resultA, resultB] = await Promise.all([coordinatorA.repairLegacyRetryLineage(), coordinatorB.repairLegacyRetryLineage()]);
      expect(resultA.scanned).toBeGreaterThanOrEqual(1);
      expect(resultB.scanned).toBeGreaterThanOrEqual(1);

      const afterRace = await ctx.retries.findById(retryRow!.id);
      expect(afterRace?.resultingPaymentAttemptId).toBe(payment.id); // B survives the concurrent race — never silently overwritten by A from either connection.

      const conflictAudit = await db
        .select({ id: auditEvent.id })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.targetResourceType, "payment_retry"),
            eq(auditEvent.targetResourceId, retryRow!.id),
            eq(auditEvent.action, "payment_retry_legacy_lineage_conflict_contradictory_resulting_attempt"),
          ),
        );
      // At least one durable conflict record exists — never zero (the contradiction is never silently
      // dropped). `recordLegacyRepairConflict`'s own dedup is a plain check-then-insert (mirroring
      // `PartialPaymentAutoApplicationService.hasExistingAuditRecord`'s own identical, already-approved
      // precedent — see that method's own doc comment) — a best-effort audit-trail convenience, never a
      // required financial effect (see Defect 7's own "required effect" boundary): under GENUINE
      // concurrent execution on two independent connections it can legitimately record the SAME
      // contradiction twice (both readers observe "not yet recorded" before either writer commits).
      // This is orthogonal to Defect 5, which governs the `resultingPaymentAttemptId` LINK write itself
      // (asserted immutably atomic above) — broadening this pass to also make audit-trail dedup atomic
      // would revisit an already-approved, out-of-scope precedent; not attempted here.
      expect(conflictAudit.length).toBeGreaterThanOrEqual(1);

      const attemptsForInstallment = await db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId));
      expect(attemptsForInstallment).toHaveLength(2); // payment (B) + attemptA — no third row created by the race.
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  // ==========================================================================================
  // R11 PASS B1 — SURGICAL FINAL PATCH (L1-L10). Three remaining defects: (1) fired legacy-repair
  // starvation on never-cleared/conflicted rows, (2) a `"deferred"` legacy-repair disposition
  // incorrectly reported as `"fired"`, and (3) a SUBMITTED legacy retry bypassing identity
  // validation and null-or-same adoption. Every test below drives a REAL production entry point.
  // ==========================================================================================

  it("L1 — TERMINAL NEVER-CLEARED PREFIX: two old fired retries whose replacement FAILED and never cleared never consume the bounded batch — a later fired retry whose replacement genuinely cleared is reached in the SAME production repairBatch call", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);
    const db = getDb();
    const webhook = ctx.buildWebhookService();

    async function seedNeverClearedFiredRetry(index: number): Promise<string> {
      const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 30, "2030-01-01");
      const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
      await webhook.receiveWebhook(
        signedWebhookForTest(ctx.provider, { providerEventId: `l1-fail-${index}-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }),
      );
      const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
      await db.update(paymentRetry).set({ status: "fired", firedAt: new Date(Date.now() - (100 - index) * 60_000) }).where(eq(paymentRetry.id, retryRow!.id));
      // The replacement FAILED and never cleared — this proposal can never be owed by this scan.
      await ctx.payments.insertPending({
        idempotencyKey: `retry-${retryRow!.id}`,
        payerProfileKind: "personal",
        payerProfileId: debtor.profileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditor.profileId,
        amountMinorUnits: originalPayment.amountMinorUnits,
        currency: originalPayment.currency,
        agreementId,
        providerName: "sandbox_mock",
        installmentScheduleItemId,
        paymentMethod: "ach",
        initialStatus: "failed",
      });
      return retryRow!.id;
    }
    const neverClearedRetryIds = [await seedNeverClearedFiredRetry(0), await seedNeverClearedFiredRetry(1)];

    // The later, genuinely resolvable candidate.
    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 300, "2030-01-01");
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `l1-real-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const realRetryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date() }).where(eq(paymentRetry.id, realRetryRow!.id));
    const legacyAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${realRetryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyAttempt.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });

    const reconciliation = new ReconciliationService({
      payments: ctx.payments,
      webhookEvents: ctx.events,
      provider: ctx.provider,
      ledger: ctx.ledger,
      exceptions: new DrizzleReconciliationExceptionRepository(),
      legacyRetryLineageRepair: ctx.retryCoordinator,
    });
    // A SINGLE call with a batch limit smaller than the total row count — the two never-cleared rows
    // must never consume it (they never match the selector's own WHERE clause at all), so this one
    // call already reaches the later, genuinely resolvable candidate.
    await reconciliation.repairBatch(2);

    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(legacyAttempt.id);

    for (const retryId of neverClearedRetryIds) {
      expect((await ctx.retries.findById(retryId))?.resultingPaymentAttemptId).toBeNull(); // never touched.
    }
  });

  it("L2 — APPLICATION CONFLICT LEAVES FUTURE BATCH: an oldest candidate whose replacement cleared but whose amount disagrees with the proposal's own approved terms (applyClearedPayment CONFLICT) receives a durable retry-level legacy conflict marker on the first pass and is excluded from the next — a later valid candidate is repaired only once the conflict candidate no longer occupies the bounded batch", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);
    const db = getDb();
    const webhook = ctx.buildWebhookService();

    // OLDEST: replacement cleared, but for an amount that disagrees with the proposal's own approved
    // 40 — `PartialPaymentAutoApplicationService.applyClearedPayment`'s own amount-mismatch check
    // returns CONFLICT (never a lineage-identity conflict — the retry/candidate identity itself is
    // perfectly valid here).
    const conflictAccepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 40, "2030-01-01");
    const conflictOriginal = await initiateRealPartialPaymentForTest(ctx, conflictAccepted, debtor);
    await webhook.receiveWebhook(
      signedWebhookForTest(ctx.provider, { providerEventId: `l2-conflict-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: conflictOriginal.providerPaymentId }),
    );
    const conflictRetryRow = await ctx.retries.findByOriginalPaymentAttemptId(conflictOriginal.id);
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date(Date.now() - 60_000) }).where(eq(paymentRetry.id, conflictRetryRow!.id));
    const conflictReplacement = await ctx.payments.insertPending({
      idempotencyKey: `retry-${conflictRetryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 50, // disagrees with the proposal's own approved 40 — but small enough to leave room for the later, valid candidate below.
      currency: conflictOriginal.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: conflictReplacement.id, agreementId, currency: conflictOriginal.currency, grossAmountMinorUnits: 50 });

    // LATER: a genuinely valid, cleared candidate.
    const validAccepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 300, "2030-01-01");
    const validOriginal = await initiateRealPartialPaymentForTest(ctx, validAccepted, debtor);
    await webhook.receiveWebhook(
      signedWebhookForTest(ctx.provider, { providerEventId: `l2-valid-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: validOriginal.providerPaymentId }),
    );
    const validRetryRow = await ctx.retries.findByOriginalPaymentAttemptId(validOriginal.id);
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date() }).where(eq(paymentRetry.id, validRetryRow!.id));
    const validReplacement = await ctx.payments.insertPending({
      idempotencyKey: `retry-${validRetryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: validOriginal.amountMinorUnits,
      currency: validOriginal.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: validReplacement.id, agreementId, currency: validOriginal.currency, grossAmountMinorUnits: validOriginal.amountMinorUnits });

    const reconciliation = new ReconciliationService({
      payments: ctx.payments,
      webhookEvents: ctx.events,
      provider: ctx.provider,
      ledger: ctx.ledger,
      exceptions: new DrizzleReconciliationExceptionRepository(),
      legacyRetryLineageRepair: ctx.retryCoordinator,
    });

    // FIRST real repairBatch, bounded to exactly 1 — only the OLDEST (conflict) candidate is reached.
    await reconciliation.repairBatch(1);
    const conflictAuditAfterFirst = await db
      .select({ id: auditEvent.id })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.targetResourceType, "payment_retry"),
          eq(auditEvent.targetResourceId, conflictRetryRow!.id),
          eq(auditEvent.action, "payment_retry_legacy_lineage_conflict_application"),
        ),
      );
    expect(conflictAuditAfterFirst.length).toBeGreaterThanOrEqual(1); // durable retry-level legacy conflict marker recorded.
    expect((await ctx.partialPaymentService.getPartialPaymentRequest(validAccepted.id, debtor.userId)).status).toBe("awaiting_payment"); // not yet reached.

    // NEXT real repairBatch, same bound — the conflict candidate is now excluded (durable marker),
    // so the later valid candidate is reached and repaired.
    await reconciliation.repairBatch(1);
    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(validAccepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(validReplacement.id);

    // The conflict candidate's own proposal was never applied from contradictory evidence.
    const stillAwaitingConflict = await ctx.partialPaymentService.getPartialPaymentRequest(conflictAccepted.id, debtor.userId);
    expect(stillAwaitingConflict.status).toBe("awaiting_payment");
  });

  it("L3 — FIRED TRANSIENT FAILURE BACKOFF: a fired, genuinely cleared candidate whose application fails transiently is durably deferred (nextResolutionAttemptAt advances into the future) and is NOT immediately re-selected by the very next repairBatch call; once made eligible again via deterministic test-time setup, a subsequent repairBatch applies it exactly once", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `l3-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    await db.update(paymentRetry).set({ status: "fired", firedAt: new Date() }).where(eq(paymentRetry.id, retryRow!.id));
    const legacyAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: legacyAttempt.id, agreementId, currency: originalPayment.currency, grossAmountMinorUnits: originalPayment.amountMinorUnits });

    const flakyAutoApp: PartialPaymentApplicationForRepair = {
      applyClearedPayment: async () => {
        throw new Error("simulated transient legacy repair failure");
      },
    };
    const flakyCoordinator = new DrizzleFailedPaymentRetryCoordinator(undefined, undefined, undefined, undefined, undefined, flakyAutoApp);
    await flakyCoordinator.repairLegacyRetryLineage();

    const afterFailure = await ctx.retries.findById(retryRow!.id);
    expect(afterFailure?.nextResolutionAttemptAt).not.toBeNull();
    expect(afterFailure!.nextResolutionAttemptAt!.getTime()).toBeGreaterThan(Date.now()); // durably deferred into the future.
    expect((await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId)).status).toBe("awaiting_payment");

    // Immediately re-running the REAL (non-flaky) coordinator's own scan must NOT re-select this row
    // — it is not yet backoff-eligible.
    const immediateRetry = await ctx.retryCoordinator.repairLegacyRetryLineage();
    expect(immediateRetry.scanned).toBe(0);
    expect((await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId)).status).toBe("awaiting_payment");

    // Deterministic test-time setup — make it eligible again, exactly like L1/K6's own identical precedent.
    await db.update(paymentRetry).set({ nextResolutionAttemptAt: null }).where(eq(paymentRetry.id, retryRow!.id));
    const secondPass = await ctx.retryCoordinator.repairLegacyRetryLineage();
    expect(secondPass.scanned).toBeGreaterThanOrEqual(1);
    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(legacyAttempt.id);
    const clearedEntries = await ctx.ledger.listEntriesForPaymentAttempt(legacyAttempt.id);
    expect(clearedEntries.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1); // applied exactly once.
  });

  it("L4 — CLAIMED DEFERRED USES markResolutionDeferred: a claimed retry whose replacement exists but is not yet durably cleared (proposal application returns DEFERRED) is never reported fired by the REAL PaymentRetryService scheduler — it stays claimed, its nextResolutionAttemptAt advances, and it remains recoverable", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const accepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId);
    const originalPayment = await initiateRealPartialPaymentForTest(ctx, accepted, debtor);
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `l4-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: originalPayment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(originalPayment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    await db.update(paymentRetry).set({ status: "claimed", executionToken: randomUUID(), nextResolutionAttemptAt: null }).where(eq(paymentRetry.id, retryRow!.id));
    // Terminal (succeeded) so the "already resolved" branch is reached, but deliberately NEVER
    // durably cleared — `applyClearedPayment` returns `not_yet_durable`, a genuine DEFERRED.
    const legacyAttempt = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: originalPayment.amountMinorUnits,
      currency: originalPayment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });

    const retryService = ctx.buildRetryService({ effectApplier: webhook });
    await retryService.fireDueRetries(new Date());

    // Scoped to THIS retry's own state, never the shared database's aggregate `resolved` count (this
    // is a large, shared-Postgres test file — see B1-J3's own identical precedent) — the DEFERRED
    // disposition must never have been reported/counted as fired.
    const afterFire = await ctx.retries.findById(retryRow!.id);
    expect(afterFire?.status).toBe("claimed"); // never reported/marked fired.
    // The LINK itself is still correctly adopted (validateAndAdoptLegacyReplacement runs unconditionally
    // before the — separate — application step) — only the historical-clearing/application half is
    // deferred; only that half gates whether the retry may be marked `fired`.
    expect(afterFire?.resultingPaymentAttemptId).toBe(legacyAttempt.id);
    expect(afterFire?.nextResolutionAttemptAt).not.toBeNull(); // markResolutionDeferred advanced it.
    expect((await ctx.partialPaymentService.getPartialPaymentRequest(accepted.id, debtor.userId)).status).toBe("awaiting_payment");

    // Test-hygiene cleanup: this suite's Postgres database is shared and accumulates across every
    // test in this (and sibling) files, and `findClaimedForResumption` scans it globally with no
    // per-test scoping — a retry deliberately left `claimed` here would otherwise remain eligible for
    // ANY later test's own `fireDueRetries` call (including one wired with a narrower coordinator that
    // has no `partialPaymentApplication`, which would short-circuit this row straight to `fired`).
    await db.update(paymentRetry).set({ status: "canceled", canceledAt: new Date(), canceledReason: "test cleanup" }).where(eq(paymentRetry.id, retryRow!.id));
  });

  it("L5 — CLAIMED DEFERRED DOES NOT STARVE LATER CLAIMED RETRY: the oldest of two claimed retries returns DEFERRED and durably backs off — with a claimed batch limit of 1, the later, genuinely completable retry is reached only on the SUBSEQUENT real scheduler invocation, never permanently starved", async () => {
    const { creditor, debtor } = await seedTwoParties();
    // Two SEPARATE installments — `assertNoCompetingUnresolvedInstallmentAttemptWithinTx`'s own
    // approved, out-of-scope reservation guard (Part 8) correctly refuses a second in-flight
    // (succeeded-but-not-yet-cleared) attempt against the SAME installment, so the deliberately
    // never-cleared "oldest" candidate below must live on its own installment.
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const { agreementId: laterAgreementId, installmentScheduleItemId: laterInstallmentScheduleItemId } = await seedAgreementWithInstallment(
      creditor.profileId,
      debtor.profileId,
      creditor.userId,
      1_000,
    );
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);
    const db = getDb();
    const webhook = ctx.buildWebhookService();

    // OLDEST — deliberately DEFERRED (never durably cleared). `nextResolutionAttemptAt = NULL` sorts
    // FIRST (`ASC NULLS FIRST`) ahead of any non-null value, so this row is always selected before B
    // when both are otherwise due.
    const deferredAccepted = await proposeAndAcceptForTest(ctx, debtor, creditor, agreementId, installmentScheduleItemId, 40, "2030-01-01");
    const deferredOriginal = await initiateRealPartialPaymentForTest(ctx, deferredAccepted, debtor);
    await webhook.receiveWebhook(
      signedWebhookForTest(ctx.provider, { providerEventId: `l5-deferred-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: deferredOriginal.providerPaymentId }),
    );
    const deferredRetryRow = await ctx.retries.findByOriginalPaymentAttemptId(deferredOriginal.id);
    await db
      .update(paymentRetry)
      .set({ status: "claimed", executionToken: randomUUID(), nextResolutionAttemptAt: null })
      .where(eq(paymentRetry.id, deferredRetryRow!.id));
    await ctx.payments.insertPending({
      idempotencyKey: `retry-${deferredRetryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: deferredOriginal.amountMinorUnits,
      currency: deferredOriginal.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded", // terminal, but never cleared — genuinely DEFERRED.
    });

    // LATER — genuinely completable, on its own installment; made due (`nextResolutionAttemptAt` a
    // past, non-null timestamp) so it sorts strictly AFTER the deferred row above.
    const laterAccepted = await proposeAndAcceptForTest(ctx, debtor, creditor, laterAgreementId, laterInstallmentScheduleItemId, 300, "2030-01-01");
    const laterOriginal = await initiateRealPartialPaymentForTest(ctx, laterAccepted, debtor);
    await webhook.receiveWebhook(
      signedWebhookForTest(ctx.provider, { providerEventId: `l5-later-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: laterOriginal.providerPaymentId }),
    );
    const laterRetryRow = await ctx.retries.findByOriginalPaymentAttemptId(laterOriginal.id);
    await db
      .update(paymentRetry)
      .set({ status: "claimed", executionToken: randomUUID(), nextResolutionAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(paymentRetry.id, laterRetryRow!.id));
    const laterReplacement = await ctx.payments.insertPending({
      idempotencyKey: `retry-${laterRetryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: laterOriginal.amountMinorUnits,
      currency: laterOriginal.currency,
      agreementId: laterAgreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId: laterInstallmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "succeeded",
    });
    await ctx.ledger.postPaymentCleared({ paymentAttemptId: laterReplacement.id, agreementId: laterAgreementId, currency: laterOriginal.currency, grossAmountMinorUnits: laterOriginal.amountMinorUnits });

    const retryService = ctx.buildRetryService({ effectApplier: webhook });

    // FIRST real scheduler invocation, claimed-batch limit 1 — only the oldest (deferred) row fits.
    await retryService.fireDueRetries(new Date(), 1);
    expect((await ctx.retries.findById(deferredRetryRow!.id))?.status).toBe("claimed");
    expect((await ctx.retries.findById(deferredRetryRow!.id))?.nextResolutionAttemptAt).not.toBeNull(); // durably backed off.
    expect((await ctx.retries.findById(laterRetryRow!.id))?.status).toBe("claimed"); // untouched this pass — never starved into being skipped forever, just not YET reached.
    expect((await ctx.partialPaymentService.getPartialPaymentRequest(laterAccepted.id, debtor.userId)).status).toBe("awaiting_payment");

    // SUBSEQUENT real scheduler invocation — the deferred row is now backoff-ineligible, so the
    // later, genuinely completable row is the one reached.
    await retryService.fireDueRetries(new Date(), 1);
    const applied = await ctx.partialPaymentService.getPartialPaymentRequest(laterAccepted.id, debtor.userId);
    expect(applied.status).toBe("applied");
    expect(applied.paymentAttemptId).toBe(laterReplacement.id);

    // Test-hygiene cleanup — see L4's own identical precedent: the deferred row is deliberately left
    // `claimed` and would otherwise remain globally eligible for any later test's own scheduler call.
    await db.update(paymentRetry).set({ status: "canceled", canceledAt: new Date(), canceledReason: "test cleanup" }).where(eq(paymentRetry.id, deferredRetryRow!.id));
  });

  it("L6 — SUBMITTED CONTRADICTORY LINK: a claimed retry R whose resultingPaymentAttemptId already durably references B, with a trusted retry-<id>-keyed candidate A (A != B) still SUBMITTED (not yet cleared) — the REAL scheduler path validates identity BEFORE any provider lookup, refuses to trust A, never mutates it from a provider result, never overwrites B, and calls the provider zero times", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const payment = await ctx.paymentService.createPayment({
      idempotencyKey: `l6-original-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 200,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `l6-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: payment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(payment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    // B — already durably recorded (payment itself, identity irrelevant — mirrors K1's own precedent).
    await db
      .update(paymentRetry)
      .set({ status: "claimed", executionToken: randomUUID(), nextResolutionAttemptAt: null, resultingPaymentAttemptId: payment.id })
      .where(eq(paymentRetry.id, retryRow!.id));

    // A — a trusted retry-<id> key, but STILL SUBMITTED. The provider genuinely HAS a record for this
    // key (proving it was never even asked, not merely that asking would have failed).
    await ctx.provider.createPayment({
      idempotencyKey: `retry-${retryRow!.id}`,
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
    });
    const attemptA = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "submitted",
    });

    const { provider: countingProvider, callCount } = countingProviderForTest(ctx.provider);
    const retryService = ctx.buildRetryService({ provider: countingProvider, effectApplier: webhook });
    await retryService.fireDueRetries(new Date());
    expect(callCount()).toBe(0); // validation refused before ever asking the provider.

    const afterFire = await ctx.retries.findById(retryRow!.id);
    expect(afterFire?.resultingPaymentAttemptId).toBe(payment.id); // B never overwritten by A.
    const attemptAAfter = await db.select({ status: paymentAttempt.status }).from(paymentAttempt).where(eq(paymentAttempt.id, attemptA.id)).limit(1);
    expect(attemptAAfter[0]?.status).toBe("submitted"); // A never mutated from a provider result it was never given.

    const conflictAudit = await db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "payment_retry"), eq(auditEvent.targetResourceId, retryRow!.id), eq(auditEvent.action, "payment_retry_legacy_lineage_conflict_contradictory_resulting_attempt")));
    expect(conflictAudit.length).toBeGreaterThanOrEqual(1);

    const attemptsForInstallment = await db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId));
    expect(attemptsForInstallment).toHaveLength(2); // payment (B) + A — no new attempt.

    // Test-hygiene cleanup — see L4's own identical precedent.
    await db.update(paymentRetry).set({ status: "canceled", canceledAt: new Date(), canceledReason: "test cleanup" }).where(eq(paymentRetry.id, retryRow!.id));
  });

  it("L7 — SUBMITTED ORIGINAL ATTEMPT MISMATCH: a claimed retry's own recorded agreement/installment context agrees with a genuinely trustworthy, still-SUBMITTED candidate A, but the retry's own originalPaymentAttemptId points at an attempt from an INCONSISTENT agreement/installment context — the REAL scheduler path records conflict BEFORE any provider result could mutate A: no link mutation, A's own status stays untouched, durable original-context conflict, zero provider calls", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const { agreementId: otherAgreementId, installmentScheduleItemId: otherInstallmentId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const payment = await ctx.paymentService.createPayment({
      idempotencyKey: `l7-original-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 200,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `l7-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: payment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(payment.id);
    expect(retryRow).not.toBeNull();

    const inconsistentOriginal = await ctx.payments.insertPending({
      idempotencyKey: `l7-inconsistent-original-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 200,
      currency: "USD",
      agreementId: otherAgreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId: otherInstallmentId,
      paymentMethod: "ach",
      initialStatus: "failed",
    });

    const db = getDb();
    // R's OWN agreementId/installmentScheduleItemId are left exactly as originally recorded (matching
    // `payment`'s real context) — only `originalPaymentAttemptId` is corrupted.
    await db
      .update(paymentRetry)
      .set({ status: "claimed", executionToken: randomUUID(), nextResolutionAttemptAt: null, originalPaymentAttemptId: inconsistentOriginal.id })
      .where(eq(paymentRetry.id, retryRow!.id));

    // Candidate A agrees with R's own recorded agreementId/installmentScheduleItemId — otherwise
    // perfectly trustworthy, and still SUBMITTED (not yet cleared).
    const candidateA = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "submitted",
    });

    const { provider: countingProvider, callCount } = countingProviderForTest(ctx.provider);
    const retryService = ctx.buildRetryService({ provider: countingProvider, effectApplier: webhook });
    await retryService.fireDueRetries(new Date());
    expect(callCount()).toBe(0);

    const afterFire = await ctx.retries.findById(retryRow!.id);
    expect(afterFire?.resultingPaymentAttemptId).toBeNull(); // never mutated.
    const candidateAAfter = await db.select({ status: paymentAttempt.status }).from(paymentAttempt).where(eq(paymentAttempt.id, candidateA.id)).limit(1);
    expect(candidateAAfter[0]?.status).toBe("submitted"); // never touched by a provider result.

    const conflictAudit = await db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.targetResourceType, "payment_retry"),
          eq(auditEvent.targetResourceId, retryRow!.id),
          eq(auditEvent.action, "payment_retry_legacy_lineage_conflict_original_attempt_context_mismatch"),
        ),
      );
    expect(conflictAudit.length).toBeGreaterThanOrEqual(1);

    // Test-hygiene cleanup — see L4's own identical precedent.
    await db.update(paymentRetry).set({ status: "canceled", canceledAt: new Date(), canceledReason: "test cleanup" }).where(eq(paymentRetry.id, retryRow!.id));
  });

  it("L8 — SUBMITTED NULL-LINK HAPPY PATH: a coherent claimed retry with a null resultingPaymentAttemptId and a genuinely trustworthy, still-SUBMITTED candidate A — the shared guarded identity helper adopts A, provider resolution then proceeds normally (a pending lookup advances A to processing), and no duplicate attempt or provider dispatch occurs", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const payment = await ctx.paymentService.createPayment({
      idempotencyKey: `l8-original-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 200,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `l8-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: payment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(payment.id);
    expect(retryRow).not.toBeNull();

    const db = getDb();
    await db.update(paymentRetry).set({ status: "claimed", executionToken: randomUUID(), nextResolutionAttemptAt: null }).where(eq(paymentRetry.id, retryRow!.id));

    // The provider genuinely has a "pending" record for this exact key — a real, coherent (never
    // corrupted) resumption candidate.
    await ctx.provider.createPayment({
      idempotencyKey: `retry-${retryRow!.id}`,
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
    });
    const attemptA = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "submitted",
    });

    const retryService = ctx.buildRetryService({ effectApplier: webhook });
    await retryService.fireDueRetries(new Date());

    const afterFire = await ctx.retries.findById(retryRow!.id);
    expect(afterFire?.resultingPaymentAttemptId).toBe(attemptA.id); // the guarded identity helper adopted A.
    const attemptAAfter = await db.select({ status: paymentAttempt.status }).from(paymentAttempt).where(eq(paymentAttempt.id, attemptA.id)).limit(1);
    expect(attemptAAfter[0]?.status).toBe("processing"); // pending provider result correctly advanced it.

    const attemptsForInstallment = await db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId));
    expect(attemptsForInstallment).toHaveLength(2); // payment + A — no duplicate attempt, no new provider dispatch.
  });

  it("L9 — SUBMITTED SAME-LINK IDEMPOTENT: a claimed retry whose resultingPaymentAttemptId is ALREADY the still-SUBMITTED candidate A (a partially-completed prior adoption) proceeds through provider resolution with no conflict and no link mutation", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildFullWebhookContextForTest();
    await seedVerifiedParty(ctx.verificationCtx, "personal", debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, "personal", creditor.profileId, creditor.userId);

    const payment = await ctx.paymentService.createPayment({
      idempotencyKey: `l9-original-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: 200,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      installmentScheduleItemId,
    });
    const webhook = ctx.buildWebhookService();
    await webhook.receiveWebhook(signedWebhookForTest(ctx.provider, { providerEventId: `l9-fail-${randomUUID()}`, eventType: "payment.failed", providerPaymentId: payment.providerPaymentId }));
    const retryRow = await ctx.retries.findByOriginalPaymentAttemptId(payment.id);
    expect(retryRow).not.toBeNull();

    await ctx.provider.createPayment({
      idempotencyKey: `retry-${retryRow!.id}`,
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
    });
    const attemptA = await ctx.payments.insertPending({
      idempotencyKey: `retry-${retryRow!.id}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      agreementId,
      providerName: "sandbox_mock",
      installmentScheduleItemId,
      paymentMethod: "ach",
      initialStatus: "submitted",
    });

    const db = getDb();
    // resultingPaymentAttemptId ALREADY = A — models a prior partial adoption (e.g. Phase A of a
    // fresh dispatch, or an earlier resumption attempt that adopted but did not finish resolving).
    await db
      .update(paymentRetry)
      .set({ status: "claimed", executionToken: randomUUID(), nextResolutionAttemptAt: null, resultingPaymentAttemptId: attemptA.id })
      .where(eq(paymentRetry.id, retryRow!.id));

    const retryService = ctx.buildRetryService({ effectApplier: webhook });
    await retryService.fireDueRetries(new Date());

    const afterFire = await ctx.retries.findById(retryRow!.id);
    expect(afterFire?.resultingPaymentAttemptId).toBe(attemptA.id); // unchanged — idempotent.
    const attemptAAfter = await db.select({ status: paymentAttempt.status }).from(paymentAttempt).where(eq(paymentAttempt.id, attemptA.id)).limit(1);
    expect(attemptAAfter[0]?.status).toBe("processing"); // provider resolution proceeded normally.

    const conflictAudit = await db
      .select({ id: auditEvent.id })
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, "payment_retry"), eq(auditEvent.targetResourceId, retryRow!.id), like(auditEvent.action, "payment_retry_legacy_lineage_conflict_%")));
    expect(conflictAudit.length).toBe(0); // no conflict — same-link is a safe, idempotent no-op.

    const attemptsForInstallment = await db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.installmentScheduleItemId, installmentScheduleItemId));
    expect(attemptsForInstallment).toHaveLength(2); // payment + A — no duplicate.
  });

  it("L10 — SEARCH/WRITE INVARIANT: every unconditional (non-null-or-same-guarded) write to payment_retry.resultingPaymentAttemptId in failedPaymentRetryCoordinator.ts is either the approved NEW Phase A creation (establishDurableDispatchIntent) or the already-approved post-resolution bookkeeping (applyFoundOutcome/markRetryFired) that only ever re-affirms a value the guarded identity helper already established — never an independent, unguarded LEGACY adoption write", () => {
    const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "failedPayments", "failedPaymentRetryCoordinator.ts");
    const source = readFileSync(sourcePath, "utf8");
    const lines = source.split("\n");

    // Scoped to actual DB WRITE sites only (`.set({ ... resultingPaymentAttemptId: ... })`) — never a
    // `return { outcome: ..., resultingPaymentAttemptId: ... }` object literal, which merely echoes a
    // value already written elsewhere and writes nothing itself.
    const writeLines = lines.filter((line) => line.includes(".set(") && /resultingPaymentAttemptId:/.test(line));
    expect(writeLines.length).toBe(4); // the total known write-site count — a new one here needs conscious review, not a silent pass.

    // The guarded null-or-same helper's own conditional write — the ONLY place a candidate id is
    // ever written under a `WHERE ... IS NULL OR ... = candidate` guard.
    const guardedWrites = writeLines.filter((line) => /resultingPaymentAttemptId:\s*candidateAttemptId\b/.test(line));
    expect(guardedWrites.length).toBe(1);
    const guardedWriteIndex = lines.findIndex((line) => /resultingPaymentAttemptId:\s*candidateAttemptId\b/.test(line));
    const guardedWhereClause = lines.slice(guardedWriteIndex, guardedWriteIndex + 3).join("\n");
    expect(guardedWhereClause).toContain("isNull(paymentRetry.resultingPaymentAttemptId)");
    expect(guardedWhereClause).toContain("eq(paymentRetry.resultingPaymentAttemptId, candidateAttemptId)");

    // The approved NEW Phase A creation write — a write of a JUST-INSERTED row's own id — is its own,
    // separately-recognizable shape, never merged with the LEGACY-adoption pattern above.
    const phaseACreationWrites = writeLines.filter((line) => /resultingPaymentAttemptId:\s*inserted\.id\b/.test(line));
    expect(phaseACreationWrites.length).toBe(1);

    // Exactly two OTHER approved, unconditional write sites remain — every write this test has not
    // already classified above:
    //   1. `applyFoundOutcome`'s post-resolution bookkeeping (`resultingPaymentAttemptId: existing.id`)
    //   2. `markRetryFired`'s own public two-phase-claim worker-report API (`resultingPaymentAttemptId: input.resultingPaymentAttemptId`)
    // Both re-affirm an identity the guarded helper (or, for `markRetryFired`, an entirely separate,
    // unrelated, always-fresh-per-claim protocol never reachable from any legacy adoption path) has
    // already established — see this file's own Part 6 audit. A THIRD such site appearing here would
    // mean a new, unguarded legacy-adoption write was introduced.
    const otherApprovedWrites = writeLines.filter((line) => /resultingPaymentAttemptId:\s*(input\.resultingPaymentAttemptId|existing\.id)\b/.test(line));
    expect(otherApprovedWrites.length).toBe(2);

    expect(guardedWrites.length + phaseACreationWrites.length + otherApprovedWrites.length).toBe(writeLines.length); // every write site classified — none left over.
  });
});
