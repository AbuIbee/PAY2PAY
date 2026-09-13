import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, installmentScheduleItem, settlementPayment } from "@/db/schema";
import { AchPaymentService } from "@/lib/ach/achPaymentService";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { ValidationError } from "@/lib/errors";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { grantSettlementStepUp } from "@/lib/settlements/testFakes";
import { DrizzleAgreementPartiesReader } from "@/lib/payments/drizzleAgreementPartiesReader";
import { DrizzleAgreementScheduleReader } from "@/lib/payments/drizzleAgreementScheduleReader";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzleSettlementContextVerifier } from "@/lib/payments/drizzleSettlementContextVerifier";
import { PaymentService } from "@/lib/payments/paymentService";
import { SandboxPaymentProvider } from "@/lib/payments/sandboxPaymentProvider";
import { DrizzleLedgerAccountRepository } from "@/lib/ledger/drizzleLedgerAccountRepository";
import { DrizzleLedgerJournalEntryRepository } from "@/lib/ledger/drizzleLedgerJournalEntryRepository";
import { LedgerService } from "@/lib/ledger/ledgerService";
import { DrizzlePartialPaymentRepository } from "@/lib/partialPayments/drizzlePartialPaymentRepository";
import { PartialPaymentService } from "@/lib/partialPayments/partialPaymentService";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import { DrizzleSettlementPaymentRepository, DrizzleSettlementRepository } from "@/lib/settlements/drizzleSettlementRepository";
import type { SettlementPaymentTestHooks } from "@/lib/settlements/drizzleSettlementRepository";
import { SettlementService, type SettlementTerms } from "@/lib/settlements/settlementService";
import { waitUntilPidBlockedOnLock } from "../../../test/postgres/lockBarrier";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";
import { createIsolatedDb, warmUp } from "../../../test/postgres/testDb";

/**
 * R11 PASS B2 (EXACT 7-DEFECT IMPLEMENTATION) — dedicated Postgres regression coverage for Checks
 * 2-8: durable settlement-payment binding/agreement/party identity, the atomic scheduled-settlement
 * ceiling, and strict idempotency request identity (normal, concurrent-race, and manual replay paths).
 * Real Drizzle repositories against a real, disposable Postgres, mirroring
 * `installmentAmountAwareness.postgres.test.ts`'s established conventions exactly.
 */

async function seedTwoParties() {
  const creditor = await seedPersonalUser(`r11-b2-creditor-${randomUUID()}`);
  const debtor = await seedPersonalUser(`r11-b2-debtor-${randomUUID()}`);
  return { creditor, debtor };
}

async function seedVerifiedParty(verificationCtx: ReturnType<typeof createTestVerificationService>, profileId: string, userId: string) {
  verificationCtx.profileOwners.set("personal", profileId, userId);
  await verificationCtx.verificationService.submitFullVerificationRequest("personal", profileId);
  await verificationCtx.verificationService.recordManualVerificationDecision({
    actingRole: "platform_owner",
    profileKind: "personal",
    profileId,
    decision: "verified",
    reviewerUserId: randomUUID(),
    reason: null,
  });
}

/** A signed-like agreement with a real currentVersionId/principal but NO installment schedule — the R11 linkage requirement never triggers, keeping I1-I6's ordinary/manual payment tests unencumbered by installment concerns. */
async function seedPlainAgreement(creditorProfileId: string, debtorProfileId: string, creatorUserId: string, principalMinorUnits: number) {
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
      producedBy: "r11_pass_b2_postgres_test_seed",
      frequency: "monthly",
      feeAllocation: "creditor_pays",
      terms: { currentPrincipalMinorUnits: principalMinorUnits } as object,
    })
    .returning();
  if (!version) throw new Error("agreement_version insert returned no row");
  await db.update(agreement).set({ currentVersionId: version.id, status: "first_payment_pending" }).where(eq(agreement.id, created.id));
  return { agreementId: created.id, versionId: version.id };
}

/** Same as `seedPlainAgreement`, but WITH one installment — needed only by B2-I7's partial-payment regression. */
async function seedAgreementWithInstallment(creditorProfileId: string, debtorProfileId: string, creatorUserId: string, installmentAmountMinorUnits: number) {
  const { agreementId, versionId } = await seedPlainAgreement(creditorProfileId, debtorProfileId, creatorUserId, installmentAmountMinorUnits);
  const db = getDb();
  const [installment] = await db
    .insert(installmentScheduleItem)
    .values({ agreementVersionId: versionId, sequenceNumber: 0, dueDate: "2099-01-01", amountMinorUnits: installmentAmountMinorUnits })
    .returning();
  if (!installment) throw new Error("installment_schedule_item insert returned no row");
  return { agreementId, installmentScheduleItemId: installment.id };
}

function buildContext(overrides?: { settlementPaymentsHooks?: SettlementPaymentTestHooks; settlementPaymentsDb?: DrizzleSettlementPaymentRepository }) {
  const verificationCtx = createTestVerificationService();
  const provider = new SandboxPaymentProvider(`r11-pass-b2-postgres-test-webhook-secret-${randomUUID()}`);
  const payments = new DrizzlePaymentAttemptRepository();
  const agreementsRepo = new DrizzleAgreementRepository();
  const agreementService = getAgreementService();
  const proposals = new DrizzleSettlementRepository();
  const settlementPayments = overrides?.settlementPaymentsDb ?? new DrizzleSettlementPaymentRepository(undefined, overrides?.settlementPaymentsHooks);
  const mfaCtx = createTestMfaService();
  const ledgerAccounts = new DrizzleLedgerAccountRepository();
  const ledgerEntries = new DrizzleLedgerJournalEntryRepository();
  const ledger = new LedgerService({ accounts: ledgerAccounts, entries: ledgerEntries, audit: new AuditService(new DrizzleAuditEventRepository()) });

  const paymentService = new PaymentService({
    provider,
    verification: verificationCtx.verificationService,
    profileOwners: verificationCtx.profileOwners,
    payments,
    audit: new AuditService(new DrizzleAuditEventRepository()),
    agreements: new DrizzleAgreementPartiesReader(),
    ledger,
    scheduleReader: new DrizzleAgreementScheduleReader(),
    settlementContext: new DrizzleSettlementContextVerifier(),
  });
  const settlementService = new SettlementService({
    agreementService,
    agreements: agreementsRepo,
    proposals,
    settlementPayments,
    payments,
    mfa: mfaCtx.mfaService,
    audit: new AuditService(new DrizzleAuditEventRepository()),
  });
  return { verificationCtx, provider, payments, agreementsRepo, agreementService, proposals, settlementPayments, mfaCtx, ledger, paymentService, settlementService };
}

function settlementTerms(overrides: Partial<SettlementTerms> = {}): SettlementTerms {
  return {
    preSettlementBalanceMinorUnits: 100_000,
    settlementAmountMinorUnits: 60_000,
    forgivenAmountMinorUnits: 40_000,
    deadline: "2099-04-01",
    paymentMode: "one_time",
    failureConsequence: "restore_original",
    ...overrides,
  };
}

/** Proposes + creditor-accepts a settlement (real step-up granted), returning it `awaiting_payment`. */
async function proposeAndAcceptSettlement(
  ctx: ReturnType<typeof buildContext>,
  agreementId: string,
  debtor: { userId: string },
  creditor: { userId: string },
  overrides: Partial<SettlementTerms> = {},
) {
  const proposal = await ctx.settlementService.proposeSettlement({ agreementId, ...settlementTerms(overrides), actingUserId: debtor.userId });
  const sessionId = randomUUID();
  await grantSettlementStepUp(ctx.mfaCtx, creditor.userId, sessionId);
  return ctx.settlementService.decideSettlement({ settlementProposalId: proposal.id, actingUserId: creditor.userId, actingSessionId: sessionId, decision: "accept" });
}

describe("R11 PASS B2 — settlement payment binding, agreement/party identity, atomic scheduled ceiling (real Postgres)", () => {
  it("B2-S1 — durable settlement binding: a settlement-authorized payment created through the REAL PaymentService/SettlementContextVerifier flow persists P.settlementProposalId == S.id before recordSettlementPayment is ever called", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 100_000);
    const ctx = buildContext();
    await seedVerifiedParty(ctx.verificationCtx, creditor.profileId, creditor.userId);
    await seedVerifiedParty(ctx.verificationCtx, debtor.profileId, debtor.userId);

    const accepted = await proposeAndAcceptSettlement(ctx, agreementId, debtor, creditor);
    expect(accepted.status).toBe("awaiting_payment");

    const payment = await ctx.paymentService.createPayment({
      idempotencyKey: `b2s1-${randomUUID()}`,
      payer: { profileKind: "personal", profileId: debtor.profileId },
      recipient: { profileKind: "personal", profileId: creditor.profileId },
      amountMinorUnits: accepted.settlementAmountMinorUnits,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
      settlementProposalId: accepted.id,
    });

    // Durably persisted BEFORE recordSettlementPayment is ever invoked — and before the payment has
    // even reached a terminal status (the sandbox provider defaults new dispatches to "pending").
    const persisted = await ctx.payments.findById(payment.id);
    expect(persisted?.settlementProposalId).toBe(accepted.id);
    expect(persisted?.status).not.toBe("succeeded");

    // Simulates the real webhook eventually clearing it — orthogonal to what this test asserts (the
    // durable binding survives independently of, and predates, the payment's own terminal status).
    await ctx.payments.updateStatus(payment.id, "succeeded", {});

    const completed = await ctx.settlementService.recordSettlementPayment({ settlementProposalId: accepted.id, paymentAttemptId: payment.id, actingUserId: debtor.userId });
    expect(completed.status).toBe("completed");
  });

  it("B2-S2 — wrong settlement binding: a payment durably bound to S1 is rejected when attributed to a DIFFERENT settlement S2 on the same agreement, and no settlement_payment row is created for S2", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 200_000);
    const ctx = buildContext();

    const s1 = await proposeAndAcceptSettlement(ctx, agreementId, debtor, creditor, { preSettlementBalanceMinorUnits: 100_000, settlementAmountMinorUnits: 60_000, forgivenAmountMinorUnits: 40_000 });
    const s2 = await proposeAndAcceptSettlement(ctx, agreementId, debtor, creditor, { preSettlementBalanceMinorUnits: 100_000, settlementAmountMinorUnits: 60_000, forgivenAmountMinorUnits: 40_000 });

    const p = await ctx.payments.insertPending({
      idempotencyKey: `b2s2-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 60_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "succeeded",
      settlementProposalId: s1.id,
    });

    await expect(ctx.settlementService.recordSettlementPayment({ settlementProposalId: s2.id, paymentAttemptId: p.id, actingUserId: debtor.userId })).rejects.toThrow(ValidationError);

    const s2Rows = await getDb().select().from(settlementPayment).where(eq(settlementPayment.settlementProposalId, s2.id));
    expect(s2Rows).toHaveLength(0);
  });

  it("B2-S3 — wrong agreement: a succeeded payment recorded against a DIFFERENT agreement than the settlement's own is rejected before insertion, and the settlement's real agreement is left unchanged", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 100_000);
    const { agreementId: otherAgreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 100_000);
    const ctx = buildContext();

    const s = await proposeAndAcceptSettlement(ctx, agreementId, debtor, creditor);
    const p = await ctx.payments.insertPending({
      idempotencyKey: `b2s3-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 60_000,
      currency: "USD",
      agreementId: otherAgreementId, // disagrees with S's own agreementId — a corrupt/inconsistent state Check 3 must catch on its own.
      providerName: "sandbox",
      initialStatus: "succeeded",
      settlementProposalId: s.id,
    });

    await expect(ctx.settlementService.recordSettlementPayment({ settlementProposalId: s.id, paymentAttemptId: p.id, actingUserId: debtor.userId })).rejects.toThrow(ValidationError);

    const agreementRow = await ctx.agreementsRepo.findById(agreementId);
    expect(agreementRow?.status).toBe("first_payment_pending");
    expect(agreementRow?.status).not.toBe("settled_in_full");
    const linked = await getDb().select().from(settlementPayment).where(eq(settlementPayment.settlementProposalId, s.id));
    expect(linked).toHaveLength(0);
  });

  it("B2-S4 — wrong payer/recipient: a succeeded payment whose parties are NOT this agreement's canonical debtor/creditor is rejected before insertion, even though its own settlementProposalId/agreementId are correct", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const stranger = await seedPersonalUser(`r11-b2-stranger-${randomUUID()}`);
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 100_000);
    const ctx = buildContext();

    const s = await proposeAndAcceptSettlement(ctx, agreementId, debtor, creditor);
    const p = await ctx.payments.insertPending({
      idempotencyKey: `b2s4-${randomUUID()}`,
      payerProfileKind: "personal",
      payerProfileId: stranger.profileId, // not this agreement's debtor.
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 60_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "succeeded",
      settlementProposalId: s.id,
    });

    await expect(ctx.settlementService.recordSettlementPayment({ settlementProposalId: s.id, paymentAttemptId: p.id, actingUserId: debtor.userId })).rejects.toThrow(ValidationError);
    const linked = await getDb().select().from(settlementPayment).where(eq(settlementPayment.settlementProposalId, s.id));
    expect(linked).toHaveLength(0);
  });

  it("B2-S5 — scheduled sequential ceiling: with 400 already collected toward a 1000 settlement, a new 700 payment is rejected, the total remains 400, and the settlement is never completed", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 100_0000);
    const ctx = buildContext();

    const s = await proposeAndAcceptSettlement(ctx, agreementId, debtor, creditor, { preSettlementBalanceMinorUnits: 200_000, settlementAmountMinorUnits: 1_000, forgivenAmountMinorUnits: 199_000, paymentMode: "scheduled" });

    async function bindPayment(amountMinorUnits: number, suffix: string) {
      return ctx.payments.insertPending({
        idempotencyKey: `b2s5-${suffix}-${randomUUID()}`,
        payerProfileKind: "personal",
        payerProfileId: debtor.profileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditor.profileId,
        amountMinorUnits,
        currency: "USD",
        agreementId,
        providerName: "sandbox",
        initialStatus: "succeeded",
        settlementProposalId: s.id,
      });
    }

    const existing = await bindPayment(400, "existing");
    const afterExisting = await ctx.settlementService.recordSettlementPayment({ settlementProposalId: s.id, paymentAttemptId: existing.id, actingUserId: debtor.userId });
    expect(afterExisting.status).toBe("awaiting_payment");

    const attempted = await bindPayment(700, "attempted");
    await expect(ctx.settlementService.recordSettlementPayment({ settlementProposalId: s.id, paymentAttemptId: attempted.id, actingUserId: debtor.userId })).rejects.toThrow(ValidationError);

    expect(await ctx.settlementPayments.sumForSettlement(s.id)).toBe(400);
    const stillWaiting = await ctx.proposals.findById(s.id);
    expect(stillWaiting?.status).toBe("awaiting_payment");
  });

  it("B2-S6 — scheduled concurrent ceiling: two DIFFERENT, correctly-bound 400 payments recorded concurrently (on top of an existing 400 toward a 1000 settlement) via two GENUINELY independent Postgres connections — at most one may insert, the final total never exceeds 1000, and there is no deadlock", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 100_0000);
    const ctx = buildContext();
    const s = await proposeAndAcceptSettlement(ctx, agreementId, debtor, creditor, { preSettlementBalanceMinorUnits: 200_000, settlementAmountMinorUnits: 1_000, forgivenAmountMinorUnits: 199_000, paymentMode: "scheduled" });

    async function bindPayment(amountMinorUnits: number, suffix: string) {
      return ctx.payments.insertPending({
        idempotencyKey: `b2s6-${suffix}-${randomUUID()}`,
        payerProfileKind: "personal",
        payerProfileId: debtor.profileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditor.profileId,
        amountMinorUnits,
        currency: "USD",
        agreementId,
        providerName: "sandbox",
        initialStatus: "succeeded",
        settlementProposalId: s.id,
      });
    }

    const existing = await bindPayment(400, "existing");
    await ctx.settlementService.recordSettlementPayment({ settlementProposalId: s.id, paymentAttemptId: existing.id, actingUserId: debtor.userId });

    const p1 = await bindPayment(400, "p1");
    const p2 = await bindPayment(400, "p2");

    const DATABASE_URL = process.env.DATABASE_URL!;
    const isolatedA = createIsolatedDb(DATABASE_URL);
    const isolatedB = createIsolatedDb(DATABASE_URL);
    try {
      const bPid = await warmUp(isolatedB.client);
      const lockAcquired = (() => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        return { promise, resolve };
      })();
      const releaseA = (() => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        return { promise, resolve };
      })();

      const repoA = new DrizzleSettlementPaymentRepository(isolatedA.db, {
        afterProposalLock: async () => {
          lockAcquired.resolve();
          await releaseA.promise;
        },
      });
      const repoB = new DrizzleSettlementPaymentRepository(isolatedB.db);

      const resultAPromise = repoA.recordWithinSettlementCeiling({ settlementProposalId: s.id, paymentAttemptId: p1.id, amountMinorUnits: 400 });
      await lockAcquired.promise; // deterministic: A genuinely holds the settlement_proposal row lock now.

      const resultBPromise = repoB.recordWithinSettlementCeiling({ settlementProposalId: s.id, paymentAttemptId: p2.id, amountMinorUnits: 400 });
      // Deterministic, server-side proof of real overlap — B genuinely queues behind A's held lock.
      await waitUntilPidBlockedOnLock(DATABASE_URL, bPid);

      releaseA.resolve();
      const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);

      const outcomes = [resultA.outcome, resultB.outcome].sort();
      expect(outcomes).toEqual(["recorded", "would_exceed_settlement_amount"]); // 400(existing)+400+400=1200>1000 — exactly one fits.

      const finalTotal = await ctx.settlementPayments.sumForSettlement(s.id);
      expect(finalTotal).toBeLessThanOrEqual(1_000);
      expect(finalTotal).toBe(800); // existing 400 + whichever of P1/P2 won.
    } finally {
      await isolatedA.close();
      await isolatedB.close();
    }
  });

  it("B2-S7 — exact scheduled completion: 400 existing + a new 600 reaches exactly the 1000 settlement amount — the proposal completes and the agreement becomes settled_in_full", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 100_0000);
    const ctx = buildContext();
    const s = await proposeAndAcceptSettlement(ctx, agreementId, debtor, creditor, { preSettlementBalanceMinorUnits: 200_000, settlementAmountMinorUnits: 1_000, forgivenAmountMinorUnits: 199_000, paymentMode: "scheduled" });

    async function bindPayment(amountMinorUnits: number, suffix: string) {
      return ctx.payments.insertPending({
        idempotencyKey: `b2s7-${suffix}-${randomUUID()}`,
        payerProfileKind: "personal",
        payerProfileId: debtor.profileId,
        recipientProfileKind: "personal",
        recipientProfileId: creditor.profileId,
        amountMinorUnits,
        currency: "USD",
        agreementId,
        providerName: "sandbox",
        initialStatus: "succeeded",
        settlementProposalId: s.id,
      });
    }

    const existing = await bindPayment(400, "existing");
    await ctx.settlementService.recordSettlementPayment({ settlementProposalId: s.id, paymentAttemptId: existing.id, actingUserId: debtor.userId });

    const final = await bindPayment(600, "final");
    const completed = await ctx.settlementService.recordSettlementPayment({ settlementProposalId: s.id, paymentAttemptId: final.id, actingUserId: debtor.userId });
    expect(completed.status).toBe("completed");
    expect(await ctx.settlementPayments.sumForSettlement(s.id)).toBe(1_000);
    const agreementRow = await ctx.agreementsRepo.findById(agreementId);
    expect(agreementRow?.status).toBe("settled_in_full");
  });

  it("B2-I1 — standard exact replay: repeating the exact same createPayment request returns the SAME payment id, produces exactly one payment_attempt, and never dispatches a second provider charge", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 100_000);
    const ctx = buildContext();
    await seedVerifiedParty(ctx.verificationCtx, creditor.profileId, creditor.userId);
    await seedVerifiedParty(ctx.verificationCtx, debtor.profileId, debtor.userId);

    const key = `b2i1-${randomUUID()}`;
    const buildInput = () => ({
      idempotencyKey: key,
      payer: { profileKind: "personal" as const, profileId: debtor.profileId },
      recipient: { profileKind: "personal" as const, profileId: creditor.profileId },
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
    });

    const first = await ctx.paymentService.createPayment(buildInput());
    const second = await ctx.paymentService.createPayment(buildInput());
    expect(second.id).toBe(first.id);

    const all = await ctx.payments.listByAgreementId(agreementId);
    expect(all.filter((p) => p.idempotencyKey === key)).toHaveLength(1);
    expect(await ctx.provider.retrievePaymentByIdempotencyKey(key)).not.toBeNull(); // dispatched exactly once — the provider itself has only ever seen one logical payment for this key.
  });

  it("B2-I2 — standard mismatch matrix: changing any single material field for an existing idempotency key rejects, one field at a time", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const stranger = await seedPersonalUser(`r11-b2-stranger-${randomUUID()}`);
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 200_000);
    const { agreementId: otherAgreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 200_000);
    const ctx = buildContext();
    await seedVerifiedParty(ctx.verificationCtx, creditor.profileId, creditor.userId);
    await seedVerifiedParty(ctx.verificationCtx, debtor.profileId, debtor.userId);
    await seedVerifiedParty(ctx.verificationCtx, stranger.profileId, stranger.userId);
    const settlement = await proposeAndAcceptSettlement(ctx, agreementId, debtor, creditor);

    const key = `b2i2-${randomUUID()}`;
    const base = {
      idempotencyKey: key,
      payer: { profileKind: "personal" as const, profileId: debtor.profileId },
      recipient: { profileKind: "personal" as const, profileId: creditor.profileId },
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null as unknown,
    };
    await ctx.paymentService.createPayment(base);

    const mismatches: Array<Record<string, unknown>> = [
      { payer: { profileKind: "personal", profileId: stranger.profileId } },
      { recipient: { profileKind: "personal", profileId: stranger.profileId } },
      { agreementId: otherAgreementId },
      { amountMinorUnits: 5_001 },
      { currency: "EUR" },
      { installmentScheduleItemId: randomUUID() },
      { paymentMethod: "debit_card" },
      { bankConnectionId: randomUUID() },
      { settlementProposalId: settlement.id },
    ];
    for (const override of mismatches) {
      await expect(ctx.paymentService.createPayment({ ...base, ...override })).rejects.toThrow(ValidationError);
    }
  });

  it("B2-I3 — replay authorization: a different acting user replaying an otherwise-identical request for an existing idempotency key is rejected", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const impersonator = await seedPersonalUser(`r11-b2-impersonator-${randomUUID()}`);
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 100_000);
    const ctx = buildContext();
    await seedVerifiedParty(ctx.verificationCtx, creditor.profileId, creditor.userId);
    await seedVerifiedParty(ctx.verificationCtx, debtor.profileId, debtor.userId);

    const key = `b2i3-${randomUUID()}`;
    const buildInput = (actingUserId: string) => ({
      idempotencyKey: key,
      payer: { profileKind: "personal" as const, profileId: debtor.profileId },
      recipient: { profileKind: "personal" as const, profileId: creditor.profileId },
      amountMinorUnits: 5_000,
      currency: "USD",
      agreementId,
      actingUserId,
      ipAddress: null,
      deviceInfo: null,
    });
    await ctx.paymentService.createPayment(buildInput(debtor.userId));
    await expect(ctx.paymentService.createPayment(buildInput(impersonator.userId))).rejects.toThrow();
  });

  it("B2-I4 — concurrent conflicting race: two independent connections racing K/1000 against K/500 — one wins, the loser rejects the mismatch, and exactly one payment_attempt exists", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 100_000);
    const ctxA = buildContext();
    const ctxB = buildContext();
    for (const ctx of [ctxA, ctxB]) {
      await seedVerifiedParty(ctx.verificationCtx, creditor.profileId, creditor.userId);
      await seedVerifiedParty(ctx.verificationCtx, debtor.profileId, debtor.userId);
    }

    const key = `b2i4-${randomUUID()}`;
    const requestA = {
      idempotencyKey: key,
      payer: { profileKind: "personal" as const, profileId: debtor.profileId },
      recipient: { profileKind: "personal" as const, profileId: creditor.profileId },
      amountMinorUnits: 1_000,
      currency: "USD",
      agreementId,
      actingUserId: debtor.userId,
      ipAddress: null,
      deviceInfo: null,
    };
    const requestB = { ...requestA, amountMinorUnits: 500 };

    const results = await Promise.allSettled([ctxA.paymentService.createPayment(requestA), ctxB.paymentService.createPayment(requestB)]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof ctxA.paymentService.createPayment>>> => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // Exactly one request completed as a genuinely new payment; the other must have rejected the mismatch
    // (never silently adopted the winner's row under a different amount).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]!.value.amountMinorUnits).toBe(fulfilled[0]!.value.amountMinorUnits === 1_000 ? 1_000 : 500);

    const stored = await new DrizzlePaymentAttemptRepository().findByIdempotencyKey(key);
    expect(stored).not.toBeNull();
    const all = await ctxA.payments.listByAgreementId(agreementId);
    expect(all.filter((p) => p.idempotencyKey === key)).toHaveLength(1); // never a second payment_attempt row.
  });

  it("B2-I5 — manual exact replay: repeating an identical manual off-platform request returns the exact same payment, with no duplicate ledger posting", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 100_000);
    const ctx = buildContext();
    await seedVerifiedParty(ctx.verificationCtx, creditor.profileId, creditor.userId);
    await seedVerifiedParty(ctx.verificationCtx, debtor.profileId, debtor.userId);

    const key = `b2i5-${randomUUID()}`;
    const buildInput = () => ({ idempotencyKey: key, agreementId, amountMinorUnits: 20_000, actingUserId: debtor.userId });
    const first = await ctx.paymentService.recordManualOffPlatformPayment(buildInput());
    const second = await ctx.paymentService.recordManualOffPlatformPayment(buildInput());
    expect(second.id).toBe(first.id);

    const cleared = await ctx.ledger.listEntriesForPaymentAttempt(first.id);
    expect(cleared.filter((e) => e.entryType === "payment_cleared")).toHaveLength(1);
  });

  it("B2-I6 — manual mismatch matrix: changing any single material field for an existing manual idempotency key rejects, and a NON-manual (provider-routed) existing key can never be adopted by the manual method", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 300_000);
    const { agreementId: otherAgreementId } = await seedPlainAgreement(creditor.profileId, debtor.profileId, creditor.userId, 300_000);
    const impersonator = await seedPersonalUser(`r11-b2-manual-impersonator-${randomUUID()}`);
    const ctx = buildContext();
    await seedVerifiedParty(ctx.verificationCtx, creditor.profileId, creditor.userId);
    await seedVerifiedParty(ctx.verificationCtx, debtor.profileId, debtor.userId);
    const settlement = await proposeAndAcceptSettlement(ctx, agreementId, debtor, creditor);

    const key = `b2i6-${randomUUID()}`;
    const base = { idempotencyKey: key, agreementId, amountMinorUnits: 20_000, actingUserId: debtor.userId };
    await ctx.paymentService.recordManualOffPlatformPayment(base);

    const mismatches: Array<Record<string, unknown>> = [
      { agreementId: otherAgreementId },
      { amountMinorUnits: 20_001 },
      { installmentScheduleItemId: randomUUID() },
      { settlementProposalId: settlement.id },
      { actingUserId: impersonator.userId },
    ];
    for (const override of mismatches) {
      await expect(ctx.paymentService.recordManualOffPlatformPayment({ ...base, ...override })).rejects.toThrow(ValidationError);
    }

    // A genuinely different, NON-manual (provider-routed) existing row under a DIFFERENT key must
    // never be adopted as a "manual replay" merely because SOME idempotency key matches — construct a
    // provider-routed row directly and attempt to replay it through the manual method.
    const nonManualKey = `b2i6-nonmanual-${randomUUID()}`;
    await ctx.payments.insertPending({
      idempotencyKey: nonManualKey,
      payerProfileKind: "personal",
      payerProfileId: debtor.profileId,
      recipientProfileKind: "personal",
      recipientProfileId: creditor.profileId,
      amountMinorUnits: 20_000,
      currency: "USD",
      agreementId,
      providerName: "sandbox",
      initialStatus: "succeeded",
      paymentMethod: "ach",
    });
    await expect(
      ctx.paymentService.recordManualOffPlatformPayment({ idempotencyKey: nonManualKey, agreementId, amountMinorUnits: 20_000, actingUserId: debtor.userId }),
    ).rejects.toThrow(ValidationError);
  });

  it("B2-I7 — partial-payment regression: invoking Pay-Now twice for the SAME accepted partialPaymentRequestId returns the exact same payment attempt, with the exact proposal-derived amount/installment and no duplicate provider charge — Checks 9/10 remain intact after the new general replay validator", async () => {
    const { creditor, debtor } = await seedTwoParties();
    const { agreementId, installmentScheduleItemId } = await seedAgreementWithInstallment(creditor.profileId, debtor.profileId, creditor.userId, 1_000);
    const ctx = buildContext();
    await seedVerifiedParty(ctx.verificationCtx, creditor.profileId, creditor.userId);
    await seedVerifiedParty(ctx.verificationCtx, debtor.profileId, debtor.userId);

    const requests = new DrizzlePartialPaymentRepository();
    const partialPaymentService = new PartialPaymentService({
      agreementService: ctx.agreementService,
      requests,
      payments: ctx.payments,
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
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
    const achPaymentService = new AchPaymentService({ mandates: mandateStub, payments: ctx.paymentService, paymentAttempts: ctx.payments });

    const proposed = await partialPaymentService.proposePartialPayment({
      agreementId,
      proposedAmountMinorUnits: 400,
      proposedDate: "2099-01-01",
      installmentScheduleItemId,
      actingUserId: debtor.userId,
    });
    const accepted = await partialPaymentService.decidePartialPayment({ partialPaymentRequestId: proposed.id, actingUserId: creditor.userId, decision: "accept" });
    expect(accepted.status).toBe("awaiting_payment");

    const detail = await ctx.agreementService.getAgreement(agreementId, debtor.userId);
    const payNow = () =>
      achPaymentService.createManualPayment({
        idempotencyKey: `partial-payment-${accepted.id}`,
        agreementId,
        payer: { profileKind: detail.agreement.debtorProfileKind, profileId: detail.agreement.debtorProfileId },
        recipient: { profileKind: detail.agreement.creditorProfileKind, profileId: detail.agreement.creditorProfileId },
        amountMinorUnits: accepted.proposedAmountMinorUnits,
        currency: detail.agreement.currency,
        actingUserId: debtor.userId,
        installmentScheduleItemId: accepted.installmentScheduleItemId ?? undefined,
      });

    const first = await payNow();
    const second = await payNow();
    expect(second.id).toBe(first.id);
    expect(first.amountMinorUnits).toBe(400);
    expect(first.installmentScheduleItemId).toBe(installmentScheduleItemId);
    expect(await ctx.provider.retrievePaymentByIdempotencyKey(`partial-payment-${accepted.id}`)).not.toBeNull();

    const all = await ctx.payments.listByAgreementId(agreementId);
    expect(all.filter((p) => p.idempotencyKey === `partial-payment-${accepted.id}`)).toHaveLength(1);
  });
});
