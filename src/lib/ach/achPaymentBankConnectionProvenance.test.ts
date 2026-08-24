import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestAchServices } from "./testFakes";

const PAYER = { profileKind: "personal" as const, profileId: "bcid-payer-1" };
const RECIPIENT = { profileKind: "business" as const, profileId: "bcid-recipient-1" };
const PAYER_USER_ID = "bcid-payer-user-1";
const RECIPIENT_USER_ID = "bcid-recipient-user-1";
const REVIEWER_USER_ID = "bcid-reviewer-1";
const RAW_ROUTING_NUMBER_LOOKALIKE = "021000021";
const RAW_ACCOUNT_NUMBER_LOOKALIKE = "123456789012";

/**
 * Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md) Ledger Payment-Source
 * Rule: "the ledger must identify a payment source using an internal bank_connection_id, never a
 * routing or account number." Proves this at the payment_attempt level (the row the ledger's own
 * journal entries transitively reach — see ledger.ts's own doc comment for that "transitively"
 * precedent), not merely by code inspection.
 */
describe("Phase 6A: payment_attempt.bank_connection_id provenance", () => {
  let ach: ReturnType<typeof createTestAchServices>;
  const agreementId = randomUUID();
  const installmentId = randomUUID();

  beforeEach(async () => {
    ach = createTestAchServices();
    ach.paymentCtx.verificationCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    ach.paymentCtx.verificationCtx.profileOwners.set(RECIPIENT.profileKind, RECIPIENT.profileId, RECIPIENT_USER_ID);
    for (const ref of [PAYER, RECIPIENT]) {
      await ach.paymentCtx.verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
      await ach.paymentCtx.verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
  });

  it("stamps payment_attempt.bank_connection_id from the active mandate's known financial_account when one exists", async () => {
    const mandate = await ach.achMandateService.authorize({
      agreementId,
      payer: PAYER,
      bankAccountRef: "sandbox_bank_opaque_ref_1",
      actingUserId: PAYER_USER_ID,
    });
    // Mirrors AchMandateFinancialAccountAdapter's own narrow direct-update precedent (see that
    // file's doc comment) — the one place a mandate's financial_account_id is ever set.
    const financialAccountId = randomUUID();
    ach.mandates.byId.get(mandate.id)!.financialAccountId = financialAccountId;

    const scheduled = await ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "bcid-1",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });

    expect(scheduled.bankConnectionId).toBe(financialAccountId);
  });

  it("leaves payment_attempt.bank_connection_id null when the active mandate has no known financial_account (pre-Phase-6A style direct authorization) — never a routing/account number substitute", async () => {
    await ach.achMandateService.authorize({
      agreementId,
      payer: PAYER,
      bankAccountRef: "sandbox_bank_opaque_ref_2",
      actingUserId: PAYER_USER_ID,
    });

    const scheduled = await ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "bcid-2",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });

    expect(scheduled.bankConnectionId).toBeNull();
  });

  it("invariant 5 & 8: no field on payment_attempt is or ever contains a routing/account number — bank_connection_id is always an opaque internal id, never a credential substitute", async () => {
    const mandate = await ach.achMandateService.authorize({
      agreementId,
      payer: PAYER,
      bankAccountRef: "sandbox_bank_opaque_ref_3",
      actingUserId: PAYER_USER_ID,
    });
    ach.mandates.byId.get(mandate.id)!.financialAccountId = randomUUID();

    const scheduled = await ach.achPaymentService.scheduleInstallmentPayment({
      idempotencyKey: "bcid-3",
      installmentScheduleItemId: installmentId,
      agreementId,
      payer: PAYER,
      recipient: RECIPIENT,
      amountMinorUnits: 5_000,
      currency: "USD",
      actingUserId: PAYER_USER_ID,
    });

    const keys = Object.keys(scheduled);
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain("routingnumber");
      expect(key.toLowerCase()).not.toContain("accountnumber");
    }
    const serialized = JSON.stringify(scheduled);
    expect(serialized).not.toContain(RAW_ROUTING_NUMBER_LOOKALIKE);
    expect(serialized).not.toContain(RAW_ACCOUNT_NUMBER_LOOKALIKE);
  });
});
