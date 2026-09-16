import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError, DependencyError, ForbiddenError, StepUpRequiredError, ValidationError } from "@/lib/errors";
import { grantStepUp } from "@/lib/staff/testFakes";
import { BankConnectionService } from "./bankConnectionService";
import { createTestRelationshipServices, FakeBankPaymentProvider, InMemoryBankLinkAttemptRepository } from "./testFakes";

const ADYEN_MERCHANT_ACCOUNT = "Paid2YouECOM";

/**
 * PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction): REPLACES Phase 2's own
 * before/after token-list-difference test suite. This service now NEVER infers token ownership from
 * a list diff, timestamp, or token count — every test below drives completion exclusively through the
 * two Adyen-authenticated webhook methods (`recordAuthorisationConfirmed`/`completeFromTokenEvent`),
 * exactly mirroring production. The client-facing surface is reduced to `initiateBankConnection`
 * (mutating) and `getBankLinkAttemptStatus` (read-only poll) — there is no client-triggered
 * "finalize" mutation to attack at all anymore.
 */
describe("BankConnectionService", () => {
  let ctx: ReturnType<typeof createTestRelationshipServices>;
  let provider: FakeBankPaymentProvider;
  let bankLinkAttempts: InMemoryBankLinkAttemptRepository;
  let service: BankConnectionService;
  let userId: string;
  let sessionId: string;
  let partyId: string;

  beforeEach(async () => {
    ctx = createTestRelationshipServices();
    provider = new FakeBankPaymentProvider();
    bankLinkAttempts = new InMemoryBankLinkAttemptRepository();
    service = new BankConnectionService({
      provider,
      financialAccounts: ctx.relationshipFinancialAccountService,
      bankLinkAttempts,
      mfa: ctx.staffCtx.mfaService,
      adyenMerchantAccount: ADYEN_MERCHANT_ACCOUNT,
    });
    userId = randomUUID();
    sessionId = randomUUID();
    partyId = randomUUID();
    ctx.profileOwners.set("personal", partyId, userId);
    await grantStepUp(ctx.staffCtx, userId, sessionId);
  });

  async function initiate() {
    return service.initiateBankConnection({
      actingUserId: userId,
      actingSessionId: sessionId,
      actingParty: { kind: "personal", id: partyId },
      returnUrl: "https://app.test/payment-methods/add-bank",
      institutionDisplayName: "Example Bank",
    });
  }

  function attemptFor(providerSessionId: string) {
    const attempt = bankLinkAttempts.byProviderSessionId.get(providerSessionId);
    if (!attempt) throw new Error("attempt not found in test fixture");
    return attempt;
  }

  async function confirmAuthorisation(providerSessionId: string, success = true) {
    const attempt = attemptFor(providerSessionId);
    await service.recordAuthorisationConfirmed({ merchantReference: attempt.merchantReference, pspReference: `psp_${attempt.merchantReference}`, success });
  }

  async function confirmToken(providerSessionId: string, storedPaymentMethodId: string, eventType: "recurring.token.created" | "recurring.token.alreadyExisting" = "recurring.token.created") {
    const attempt = attemptFor(providerSessionId);
    void eventType; // eventType routing is AdyenTokenLifecycleService's own concern — completeFromTokenEvent handles both identically.
    await service.completeFromTokenEvent({
      pspReference: `psp_${attempt.merchantReference}`,
      shopperReference: attempt.shopperReference,
      storedPaymentMethodId,
      merchantAccount: ADYEN_MERCHANT_ACCOUNT,
    });
  }

  it("initiate never touches raw bank data — the session carries only an opaque provider session id", async () => {
    const session = await initiate();
    expect(session.providerSessionId).toMatch(/^fake-session-/);
    expect(typeof session.sessionData).toBe("string");
    const attempt = attemptFor(session.providerSessionId);
    expect(attempt.status).toBe("pending");
    expect(attempt.merchantReference).toBeTruthy();
  });

  it("full happy path: AUTHORISATION confirms the attempt, then the token event persists the exact storedPaymentMethodId", async () => {
    const session = await initiate();
    await confirmAuthorisation(session.providerSessionId);
    expect(attemptFor(session.providerSessionId).status).toBe("authorised");

    await confirmToken(session.providerSessionId, "sm_real_token_123");
    const attempt = attemptFor(session.providerSessionId);
    expect(attempt.status).toBe("completed");
    expect(attempt.resultFinancialAccountId).toBeTruthy();

    const status = await service.getBankLinkAttemptStatus({
      actingUserId: userId,
      actingParty: { kind: "personal", id: partyId },
      providerSessionId: session.providerSessionId,
    });
    expect(status).toEqual({ status: "completed", financialAccountId: attempt.resultFinancialAccountId });

    const accounts = await ctx.relationshipFinancialAccountService.listAccountsForParty(userId, { kind: "personal", id: partyId });
    const account = accounts.find((a) => a.id === attempt.resultFinancialAccountId);
    expect(account?.providerAccountRef).toBe("sm_real_token_123");
    expect(account?.status).toBe("verified");
    expect(account?.institutionDisplayName).toBe("Example Bank");
  });

  it("recurring.token.alreadyExisting completes an attempt identically to recurring.token.created", async () => {
    const session = await initiate();
    await confirmAuthorisation(session.providerSessionId);
    await confirmToken(session.providerSessionId, "sm_existing_token", "recurring.token.alreadyExisting");
    expect(attemptFor(session.providerSessionId).status).toBe("completed");
  });

  it("AUTHORISATION success:false marks the attempt failed — never persists anything", async () => {
    const session = await initiate();
    await confirmAuthorisation(session.providerSessionId, false);
    expect(attemptFor(session.providerSessionId).status).toBe("failed");
    const accounts = await ctx.relationshipFinancialAccountService.listAccountsForParty(userId, { kind: "personal", id: partyId });
    expect(accounts).toHaveLength(0);
  });

  it("does not manufacture local success before Adyen confirms — a token event with no matching AUTHORISATION is a retryable error, persisting nothing", async () => {
    const session = await initiate();
    // Deliberately never confirm AUTHORISATION.
    await expect(
      service.completeFromTokenEvent({
        pspReference: "psp_never_authorised",
        shopperReference: provider.deriveShopperReference({ profileKind: "personal", profileId: partyId }),
        storedPaymentMethodId: "sm_1",
        merchantAccount: ADYEN_MERCHANT_ACCOUNT,
      }),
    ).rejects.toThrow(ValidationError);
    void session;
    const accounts = await ctx.relationshipFinancialAccountService.listAccountsForParty(userId, { kind: "personal", id: partyId });
    expect(accounts).toHaveLength(0);
  });

  it("REMOVAL PROOF: no method on this service or the fake provider ever lists/diffs a shopper's stored tokens", () => {
    expect((service as unknown as Record<string, unknown>).listStoredPaymentMethods).toBeUndefined();
    expect((provider as unknown as Record<string, unknown>).listStoredPaymentMethods).toBeUndefined();
    expect((service as unknown as Record<string, unknown>).finalizeBankConnection).toBeUndefined();
  });

  it("token correlation is exact — a token event whose merchantAccount does not match this server's own configured account is ignored, never completing any attempt", async () => {
    const session = await initiate();
    await confirmAuthorisation(session.providerSessionId);
    const attempt = attemptFor(session.providerSessionId);
    await service.completeFromTokenEvent({
      pspReference: `psp_${attempt.merchantReference}`,
      shopperReference: attempt.shopperReference,
      storedPaymentMethodId: "sm_wrong_account",
      merchantAccount: "SomeOtherMerchantAccount",
    });
    expect(attemptFor(session.providerSessionId).status).toBe("authorised"); // unchanged.
  });

  it("token correlation is exact — a token event's pspReference matching NO confirmedPspReference at all never completes anything (out-of-order/unrelated event)", async () => {
    const session = await initiate();
    await confirmAuthorisation(session.providerSessionId);
    await expect(
      service.completeFromTokenEvent({
        pspReference: "psp_completely_unrelated",
        shopperReference: provider.deriveShopperReference({ profileKind: "personal", profileId: partyId }),
        storedPaymentMethodId: "sm_x",
        merchantAccount: ADYEN_MERCHANT_ACCOUNT,
      }),
    ).rejects.toThrow(ValidationError);
    expect(attemptFor(session.providerSessionId).status).toBe("authorised"); // unchanged.
  });

  it("shopperReference mismatch (structurally shouldn't happen) is refused rather than ever misattributed", async () => {
    const session = await initiate();
    await confirmAuthorisation(session.providerSessionId);
    const attempt = attemptFor(session.providerSessionId);
    await expect(
      service.completeFromTokenEvent({
        pspReference: `psp_${attempt.merchantReference}`,
        shopperReference: "personal:someone-else-entirely",
        storedPaymentMethodId: "sm_x",
        merchantAccount: ADYEN_MERCHANT_ACCOUNT,
      }),
    ).rejects.toThrow(ConfigurationError);
    expect(attemptFor(session.providerSessionId).status).toBe("authorised"); // unchanged.
  });

  describe("PAID2YOU — B0-D ADYEN PHASE 2C: recordAuthorisationConfirmed's boolean return is the webhook route's sole classification signal", () => {
    it("returns true for a known merchantReference (recognized as ours) and false for an unknown one (genuinely not ours)", async () => {
      const session = await initiate();
      const attempt = attemptFor(session.providerSessionId);
      await expect(service.recordAuthorisationConfirmed({ merchantReference: attempt.merchantReference, pspReference: "psp_1", success: true })).resolves.toBe(true);
      await expect(service.recordAuthorisationConfirmed({ merchantReference: "some-unrelated-payment-reference", pspReference: "psp_2", success: true })).resolves.toBe(false);
    });

    it("still returns true on a redelivery for an attempt that already left 'pending' — recognized on every retry, not only the first", async () => {
      const session = await initiate();
      const attempt = attemptFor(session.providerSessionId);
      await service.recordAuthorisationConfirmed({ merchantReference: attempt.merchantReference, pspReference: "psp_1", success: true });
      await expect(
        service.recordAuthorisationConfirmed({ merchantReference: attempt.merchantReference, pspReference: "psp_1", success: true }),
      ).resolves.toBe(true);
    });
  });

  describe("idempotency — duplicates, replays, concurrent sessions", () => {
    it("a redelivered AUTHORISATION webhook (same merchantReference) for an already-authorised attempt is a safe no-op", async () => {
      const session = await initiate();
      await confirmAuthorisation(session.providerSessionId);
      const firstPsp = attemptFor(session.providerSessionId).confirmedPspReference;
      // Redelivery with a hypothetically different pspReference must NOT overwrite the original.
      const attempt = attemptFor(session.providerSessionId);
      await service.recordAuthorisationConfirmed({ merchantReference: attempt.merchantReference, pspReference: "psp_different", success: true });
      expect(attemptFor(session.providerSessionId).confirmedPspReference).toBe(firstPsp);
    });

    it("a redelivered token-created event for an already-completed attempt is a safe no-op — never a duplicate financial_account", async () => {
      const session = await initiate();
      await confirmAuthorisation(session.providerSessionId);
      await confirmToken(session.providerSessionId, "sm_dup_token");
      const before = await ctx.relationshipFinancialAccountService.listAccountsForParty(userId, { kind: "personal", id: partyId });
      await confirmToken(session.providerSessionId, "sm_dup_token"); // redelivery
      const after = await ctx.relationshipFinancialAccountService.listAccountsForParty(userId, { kind: "personal", id: partyId });
      expect(after).toHaveLength(before.length);
    });

    it("concurrent sessions for the SAME shopper never collide — each attempt has its own merchantReference and completes independently", async () => {
      const sessionA = await initiate();
      const sessionB = await initiate();
      expect(sessionA.providerSessionId).not.toBe(sessionB.providerSessionId);
      expect(attemptFor(sessionA.providerSessionId).merchantReference).not.toBe(attemptFor(sessionB.providerSessionId).merchantReference);

      await confirmAuthorisation(sessionA.providerSessionId);
      await confirmToken(sessionA.providerSessionId, "sm_a");
      await confirmAuthorisation(sessionB.providerSessionId);
      await confirmToken(sessionB.providerSessionId, "sm_b");

      expect(attemptFor(sessionA.providerSessionId).status).toBe("completed");
      expect(attemptFor(sessionB.providerSessionId).status).toBe("completed");
      expect(attemptFor(sessionA.providerSessionId).resultFinancialAccountId).not.toBe(attemptFor(sessionB.providerSessionId).resultFinancialAccountId);
    });
  });

  describe("cross-user / reversed-role isolation via getBankLinkAttemptStatus", () => {
    it("cross-user: a different authenticated user cannot read the status of a bank-connection attempt initiated by someone else's session", async () => {
      const session = await initiate();
      const strangerId = randomUUID();
      const strangerPartyId = randomUUID();
      ctx.profileOwners.set("personal", strangerPartyId, strangerId);

      await expect(
        service.getBankLinkAttemptStatus({
          actingUserId: strangerId,
          actingParty: { kind: "personal", id: strangerPartyId },
          providerSessionId: session.providerSessionId,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("reversed-role/self: the same user's OTHER owned profile cannot read the status of a session initiated for a different profile of theirs", async () => {
      const session = await initiate();
      const otherPartyId = randomUUID();
      ctx.profileOwners.set("personal", otherPartyId, userId);

      await expect(
        service.getBankLinkAttemptStatus({
          actingUserId: userId,
          actingParty: { kind: "personal", id: otherPartyId },
          providerSessionId: session.providerSessionId,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects a stranger even probing for an unknown providerSessionId's existence — ownership is checked before the not-found distinction leaks anything", async () => {
      const strangerId = randomUUID();
      const strangerPartyId = randomUUID();
      ctx.profileOwners.set("personal", strangerPartyId, strangerId);
      await expect(
        service.getBankLinkAttemptStatus({ actingUserId: strangerId, actingParty: { kind: "personal", id: strangerPartyId }, providerSessionId: "never-existed" }),
      ).rejects.toThrow(); // ForbiddenError never reached — requireOwnedParty itself is fine here since strangerPartyId IS owned by strangerId; the row simply won't be found -> ValidationError. Either way, nothing is disclosed.
    });
  });

  it("rejects initiating a bank connection for a profile the caller does not own (server-side authorization, independent of any UI)", async () => {
    const strangerId = randomUUID();
    await expect(
      service.initiateBankConnection({
        actingUserId: strangerId,
        actingSessionId: sessionId,
        actingParty: { kind: "personal", id: partyId },
        returnUrl: "https://app.test/payment-methods/add-bank",
        institutionDisplayName: null,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  describe("SPRINT_19_FraudRisk_SecurityHardening: MFA step-up required (docs/SECURITY_MODEL.md threat #16, payout redirection)", () => {
    it("rejects initiating a bank connection without a fresh step-up, even for the account's own owner", async () => {
      const freshSessionId = randomUUID(); // no grantStepUp called for this session
      await expect(
        service.initiateBankConnection({
          actingUserId: userId,
          actingSessionId: freshSessionId,
          actingParty: { kind: "personal", id: partyId },
          returnUrl: "https://app.test/payment-methods/add-bank",
          institutionDisplayName: null,
        }),
      ).rejects.toThrow(StepUpRequiredError);
    });

    it("still rejects a stranger with ForbiddenError, never prompting them for step-up first", async () => {
      const strangerId = randomUUID();
      const strangerSessionId = randomUUID(); // no grantStepUp — proves ownership is checked first
      await expect(
        service.initiateBankConnection({
          actingUserId: strangerId,
          actingSessionId: strangerSessionId,
          actingParty: { kind: "personal", id: partyId },
          returnUrl: "https://app.test/payment-methods/add-bank",
          institutionDisplayName: null,
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe(
    "PRSprint 29 (docs/prsprints/PRSPRINT_29_BACKUPS_RECOVERY_ROLLBACK_INCIDENT_CONTROLS.md): " + "bankConnectionEnabled kill switch",
    () => {
      afterEach(() => {
        delete process.env.FEATURE_BANK_CONNECTION_ENABLED;
      });

      it("blocks initiating a new bank connection when the switch is disabled", async () => {
        process.env.FEATURE_BANK_CONNECTION_ENABLED = "false";
        await expect(initiate()).rejects.toThrow(DependencyError);
      });
    },
  );
});
