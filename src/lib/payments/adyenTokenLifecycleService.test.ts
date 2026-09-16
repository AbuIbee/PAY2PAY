import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "@/lib/audit/auditService";
import { AchMandateService } from "@/lib/ach/achMandateService";
import { createTestAchMandateService, seedAgreementForMandateTest } from "@/lib/ach/testFakes";
import { grantStepUp } from "@/lib/staff/testFakes";
import { BankConnectionService } from "@/lib/relationships/bankConnectionService";
import { createTestRelationshipServices, FakeBankPaymentProvider, InMemoryBankLinkAttemptRepository } from "@/lib/relationships/testFakes";
import { ValidationError } from "@/lib/errors";
import { AdyenTokenLifecycleService } from "./adyenTokenLifecycleService";

const PAYER = { profileKind: "personal" as const, profileId: "payer-1" };
const CREDITOR = { profileKind: "business" as const, profileId: "creditor-1" };
const PAYER_USER_ID = "payer-user-1";
const ADYEN_MERCHANT_ACCOUNT = "Paid2YouECOM";

/**
 * PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction, items 1 & 2). Proves two things:
 *
 *   1. `recurring.token.created`/`recurring.token.alreadyExisting` are correctly delegated, verbatim,
 *      to `BankConnectionService.completeFromTokenEvent` — the sole place token->attempt correlation is
 *      verified (see that method's own test coverage in bankConnectionService.test.ts for the
 *      correlation logic itself; this file only proves the delegation wiring is correct end-to-end
 *      through a REAL `BankConnectionService`, never a stub).
 *   2. `recurring.token.disabled` disables the matching `financial_account` AND revokes every active
 *      `ach_mandate` referencing it — the concrete mechanism that makes "a disabled Adyen token becomes
 *      unusable for future Paid2You payments" true (see this class's own doc comment).
 */
describe("AdyenTokenLifecycleService", () => {
  let relCtx: ReturnType<typeof createTestRelationshipServices>;
  let achCtx: ReturnType<typeof createTestAchMandateService>;
  let achMandateService: AchMandateService;
  let bankConnections: BankConnectionService;
  let bankLinkAttempts: InMemoryBankLinkAttemptRepository;
  let provider: FakeBankPaymentProvider;
  let service: AdyenTokenLifecycleService;

  beforeEach(() => {
    relCtx = createTestRelationshipServices();
    achCtx = createTestAchMandateService();
    // Wire the SAME AchMandateService (with financialAccounts NOT required here — this test exercises
    // revokeAllForBankAccountRef directly, not the authorize-time gate) so mandate state is inspectable.
    achMandateService = new AchMandateService({
      mandates: achCtx.mandates,
      profileOwners: achCtx.profileOwners,
      agreements: achCtx.agreements,
      audit: new AuditService(achCtx.auditRepo),
    });
    provider = new FakeBankPaymentProvider();
    bankLinkAttempts = new InMemoryBankLinkAttemptRepository();
    bankConnections = new BankConnectionService({
      provider,
      financialAccounts: relCtx.relationshipFinancialAccountService,
      bankLinkAttempts,
      mfa: relCtx.staffCtx.mfaService,
      adyenMerchantAccount: ADYEN_MERCHANT_ACCOUNT,
    });
    service = new AdyenTokenLifecycleService({
      bankConnections,
      financialAccounts: relCtx.relationshipFinancialAccountService,
      achMandates: achMandateService,
      providerName: "adyen",
    });
  });

  async function seedDisabledScenario() {
    achCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    relCtx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    const agreementId = randomUUID();
    seedAgreementForMandateTest(achCtx.agreements, agreementId, PAYER, CREDITOR);

    const account = await relCtx.relationshipFinancialAccountService.addAccount({
      actingUserId: PAYER_USER_ID,
      actingParty: { kind: PAYER.profileKind, id: PAYER.profileId },
      accountType: "bank_account",
      providerName: "adyen",
      providerAccountRef: "sm_token_to_disable",
      maskedLast4: "1234",
      institutionDisplayName: null,
    });
    await relCtx.relationshipFinancialAccountService.applyVerificationResult(account.id, "verified");
    const mandate = await achMandateService.authorize({
      agreementId,
      payer: PAYER,
      bankAccountRef: "sm_token_to_disable",
      actingUserId: PAYER_USER_ID,
    });
    return { agreementId, account, mandate };
  }

  /** Drives a full initiate -> AUTHORISATION-confirmed attempt, exactly as the two real webhook routes would, so `recurring.token.created`/`alreadyExisting` tests exercise the REAL correlation chain rather than a shortcut. */
  async function seedAuthorisedAttempt() {
    const userId = randomUUID();
    const partyId = randomUUID();
    const sessionId = randomUUID();
    relCtx.profileOwners.set("personal", partyId, userId);
    await grantStepUp(relCtx.staffCtx, userId, sessionId);
    const session = await bankConnections.initiateBankConnection({
      actingUserId: userId,
      actingSessionId: sessionId,
      actingParty: { kind: "personal", id: partyId },
      returnUrl: "https://app.test/payment-methods/add-bank",
      institutionDisplayName: "Example Bank",
    });
    const attempt = bankLinkAttempts.byProviderSessionId.get(session.providerSessionId);
    if (!attempt) throw new Error("attempt missing from test fixture");
    const pspReference = `psp_${attempt.merchantReference}`;
    await bankConnections.recordAuthorisationConfirmed({ merchantReference: attempt.merchantReference, pspReference, success: true });
    return { userId, partyId, attempt, pspReference, shopperReference: attempt.shopperReference };
  }

  describe("recurring.token.created / recurring.token.alreadyExisting delegate to BankConnectionService.completeFromTokenEvent", () => {
    it("recurring.token.created persists the exact storedPaymentMethodId as a verified financial_account, bound to the originating attempt's own party", async () => {
      const { userId, partyId, pspReference, shopperReference } = await seedAuthorisedAttempt();

      await service.handleEvent({
        eventType: "recurring.token.created",
        pspReference,
        shopperReference,
        storedPaymentMethodId: "sm_real_token",
        merchantAccount: ADYEN_MERCHANT_ACCOUNT,
      });

      const accounts = await relCtx.relationshipFinancialAccountService.listAccountsForParty(userId, { kind: "personal", id: partyId });
      const account = accounts.find((a) => a.providerAccountRef === "sm_real_token");
      expect(account?.status).toBe("verified");
    });

    it("recurring.token.alreadyExisting is handled identically to recurring.token.created", async () => {
      const { userId, partyId, pspReference, shopperReference } = await seedAuthorisedAttempt();

      await service.handleEvent({
        eventType: "recurring.token.alreadyExisting",
        pspReference,
        shopperReference,
        storedPaymentMethodId: "sm_existing_token",
        merchantAccount: ADYEN_MERCHANT_ACCOUNT,
      });

      const accounts = await relCtx.relationshipFinancialAccountService.listAccountsForParty(userId, { kind: "personal", id: partyId });
      expect(accounts.find((a) => a.providerAccountRef === "sm_existing_token")?.status).toBe("verified");
    });

    it("does not swallow an unresolved correlation — a token event with no matching authorised attempt propagates a retryable ValidationError, so the webhook route returns non-2xx and Adyen redelivers", async () => {
      await expect(
        service.handleEvent({
          eventType: "recurring.token.created",
          pspReference: "psp_never_authorised",
          shopperReference: "personal:nobody",
          storedPaymentMethodId: "sm_orphan",
          merchantAccount: ADYEN_MERCHANT_ACCOUNT,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  it("recurring.token.disabled disables the matching financial_account AND revokes the active mandate referencing it", async () => {
    const { agreementId, account, mandate } = await seedDisabledScenario();

    await service.handleEvent({
      eventType: "recurring.token.disabled",
      pspReference: "psp_disable_event",
      storedPaymentMethodId: "sm_token_to_disable",
      shopperReference: "personal:payer-1",
      merchantAccount: ADYEN_MERCHANT_ACCOUNT,
    });

    const accounts = await relCtx.relationshipFinancialAccountService.listAccountsForParty(PAYER_USER_ID, { kind: "personal", id: "payer-1" });
    expect(accounts.find((a) => a.id === account.id)?.status).toBe("disabled");
    expect((await achMandateService.getActiveMandate(agreementId))).toBeNull();
    expect((await achCtx.mandates.findById(mandate.id))?.status).toBe("revoked");
  });

  it("recurring.token.disabled for a token this instance never tokenized is a safe no-op — no mandate anywhere is touched", async () => {
    const { mandate } = await seedDisabledScenario();
    await service.handleEvent({
      eventType: "recurring.token.disabled",
      pspReference: "psp_disable_unrelated",
      storedPaymentMethodId: "sm_never_seen",
      shopperReference: "personal:someone-else",
      merchantAccount: ADYEN_MERCHANT_ACCOUNT,
    });
    expect((await achCtx.mandates.findById(mandate.id))?.status).toBe("active");
  });

  it("recurring.token.updated is informational only — never disables anything or touches mandates", async () => {
    const { account, mandate } = await seedDisabledScenario();
    await service.handleEvent({
      eventType: "recurring.token.updated",
      pspReference: "psp_updated_event",
      storedPaymentMethodId: "sm_token_to_disable",
      shopperReference: "personal:payer-1",
      merchantAccount: ADYEN_MERCHANT_ACCOUNT,
    });

    const accounts = await relCtx.relationshipFinancialAccountService.listAccountsForParty(PAYER_USER_ID, { kind: "personal", id: "payer-1" });
    expect(accounts.find((a) => a.id === account.id)?.status).toBe("verified");
    expect((await achCtx.mandates.findById(mandate.id))?.status).toBe("active");
  });
});
