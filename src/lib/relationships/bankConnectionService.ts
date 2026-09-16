import "server-only";
import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import type { MfaService } from "@/lib/auth/mfaService";
import { ConfigurationError, DependencyError, ForbiddenError, StepUpRequiredError, ValidationError } from "@/lib/errors";
import { isFeatureEnabled } from "@/lib/feature-flags";
import type { PaymentProvider } from "@/lib/payments/paymentProvider";
import type { BankLinkAttemptRepository, BankLinkAttemptStatus } from "./bankLinkAttemptRepository";
import type { PartyRef } from "./relationshipInvitationService";
import type { RelationshipFinancialAccountService } from "./relationshipFinancialAccountService";

/** 30 minutes — generous enough for a shopper to complete the Adyen Web Component flow (bank login/manual entry), short enough that a stale, never-confirmed attempt cannot be resumed indefinitely. */
const BANK_LINK_ATTEMPT_TTL_MS = 30 * 60 * 1000;

/**
 * PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction) — REPLACES Phase 2's own
 * before/after stored-token list-difference mechanism (removed entirely: no method on this class or
 * `PaymentProvider` ever lists/diffs a shopper's tokens). This server NEVER receives or persists a
 * raw routing/account number under the flow below, AND never infers which token belongs to which
 * attempt from anything except Adyen's own signed webhook data:
 *
 *   1. `initiateBankConnection` — authorizes the acting party, requires MFA step-up (unchanged from
 *      the prior flow — docs/SECURITY_MODEL.md threat #16), derives this party's OWN Adyen
 *      shopperReference (`PaymentProvider.deriveShopperReference` — never client-suppliable), mints a
 *      fresh, unique `merchantReference`, and asks Adyen for a tokenization session
 *      (`createBankAccountSession`) using it. A `bank_link_attempt` row durably records the binding
 *      (session + merchantReference -> exact party + shopperReference) BEFORE the session is ever
 *      handed to the client.
 *
 *   2. `recordAuthorisationConfirmed` — called ONLY by the token-correlation webhook handler
 *      (never by a route with user/request context) when Adyen's Standard notification webhook
 *      delivers an AUTHORISATION event. Looks the attempt up by `merchantReference` (a core,
 *      always-present, HMAC-signed webhook field) — never trusts anything else. On success, records
 *      the transaction's own `pspReference` as `confirmedPspReference` and advances to "authorised".
 *
 *   3. `completeFromTokenEvent` — called ONLY by the Recurring-tokens-lifecycle webhook handler for
 *      `recurring.token.created`/`recurring.token.alreadyExisting`. Looks the attempt up by
 *      `confirmedPspReference` (matched against the token event's own `eventId`/pspReference — Adyen's
 *      own documented "PSP reference of the event that triggered the webhook") — an event with no
 *      matching "authorised" row is a genuinely unresolved ordering case (the AUTHORISATION webhook
 *      has not yet been processed) and is left for Adyen's own webhook redelivery to retry, never
 *      guessed at. Cross-checks `shopperReference` and `merchantAccount` before ever persisting
 *      anything — belt-and-suspenders on top of the `merchantReference`/`pspReference` identity chain.
 *
 *   4. `getBankLinkAttemptStatus` — the ONLY thing the client ever calls after mounting the Component.
 *      A pure, read-only, ownership-checked status poll — the client never POSTs a completion claim
 *      this server would need to trust; completion happens exclusively via steps 2/3 above.
 *
 * See `src/db/schema/bankLinkAttempt.ts`'s own doc comment for the complete design rationale.
 */
export class BankConnectionService {
  constructor(
    private readonly deps: {
      provider: PaymentProvider;
      financialAccounts: RelationshipFinancialAccountService;
      bankLinkAttempts: BankLinkAttemptRepository;
      mfa: MfaService;
      /** The exact Adyen merchant account this server is configured for — an incoming token-lifecycle event for any OTHER account is always rejected, never assumed to be ours. */
      adyenMerchantAccount: string;
    },
  ) {}

  async initiateBankConnection(input: {
    actingUserId: string;
    actingSessionId: string;
    actingParty: PartyRef;
    returnUrl: string;
    institutionDisplayName: string | null;
  }): Promise<{ providerSessionId: string; sessionData: string }> {
    // PRSprint 29-style kill switch — same flag/behavior the prior flow already used.
    if (!isFeatureEnabled("bankConnectionEnabled")) {
      throw new DependencyError("Bank account connection is temporarily unavailable. Please try again shortly.");
    }
    // SPRINT_19_FraudRisk_SecurityHardening: authorize BEFORE step-up (unchanged ordering/rationale
    // from the prior flow's own doc comment) — a stranger to this profile gets ForbiddenError without
    // ever being prompted for MFA.
    await this.deps.financialAccounts.requireOwnedParty(input.actingUserId, input.actingParty);
    const stepUpOk = await this.deps.mfa.requireStepUp({
      userId: input.actingUserId,
      sessionId: input.actingSessionId,
      action: "connect_bank_account",
    });
    if (!stepUpOk) {
      throw new StepUpRequiredError(
        "Step-up verification is required before connecting a bank account. Please complete a fresh verification challenge and try again.",
      );
    }

    const shopperReference = this.deps.provider.deriveShopperReference({ profileKind: input.actingParty.kind, profileId: input.actingParty.id });
    const merchantReference = randomUUID();
    const session = await this.deps.provider.createBankAccountSession({ shopperReference, returnUrl: input.returnUrl, merchantReference });

    await this.deps.bankLinkAttempts.insert({
      providerSessionId: session.providerSessionId,
      merchantReference,
      actingUserId: input.actingUserId,
      partyProfileKind: input.actingParty.kind,
      partyIndividualProfileId: input.actingParty.kind === "personal" ? input.actingParty.id : null,
      partyOrganizationId: input.actingParty.kind === "business" ? input.actingParty.id : null,
      shopperReference,
      institutionDisplayName: input.institutionDisplayName,
      expiresAt: new Date(Date.now() + BANK_LINK_ATTEMPT_TTL_MS),
    });

    return session;
  }

  /**
   * PAID2YOU — B0-D ADYEN PHASE 2A: the ONLY method the client-facing status endpoint calls — never
   * mutates anything toward "completed" (that only ever happens via the webhook-driven methods below).
   * Ownership-checked exactly like `initiateBankConnection`, so a stranger cannot even learn whether an
   * attempt exists. Lazily expires a stale `pending`/`authorised` row past its own TTL.
   */
  async getBankLinkAttemptStatus(input: {
    actingUserId: string;
    actingParty: PartyRef;
    providerSessionId: string;
  }): Promise<{ status: BankLinkAttemptStatus; financialAccountId: string | null }> {
    await this.deps.financialAccounts.requireOwnedParty(input.actingUserId, input.actingParty);
    const attempt = await this.deps.bankLinkAttempts.findByProviderSessionId(input.providerSessionId);
    if (!attempt) {
      throw new ValidationError("This bank-connection attempt was not found. Please start again.");
    }
    this.requireAttemptBelongsToParty(attempt, input.actingUserId, input.actingParty);

    if ((attempt.status === "pending" || attempt.status === "authorised") && attempt.expiresAt.getTime() < Date.now()) {
      const expired = await this.deps.bankLinkAttempts.markFailed(attempt.id);
      return { status: expired.status, financialAccountId: null };
    }
    return { status: attempt.status, financialAccountId: attempt.resultFinancialAccountId };
  }

  /**
   * PAID2YOU — B0-D ADYEN PHASE 2A (updated PHASE 2C — webhook isolation): called ONLY by the
   * Standard-notifications webhook route (never by anything with a real acting user — there is none,
   * this is Adyen's own authoritative signal). See this class's own doc comment, step 2.
   *
   * Returns whether `merchantReference` is a genuinely persisted `bank_link_attempt` reference — the
   * SOLE, authoritative classification signal the webhook route uses to decide whether this delivery
   * belongs to bank-linking at all (PHASE 2C item 1/3): `true` means this event IS one of ours (this
   * call already durably recorded it, or safely no-opped on a redelivery/out-of-order arrival — either
   * way, the caller must NOT also hand this event to `PaymentWebhookService`). `false` means no
   * matching row exists — genuinely NOT a bank-link reference (every OTHER payment's own AUTHORISATION
   * webhook also passes through here), and the caller must fall through to ordinary payment-webhook
   * processing. Never inferred from the event's shape/eventCode/amount — only ever from a real
   * `findByMerchantReference` row lookup, so an unrecognized reference is never silently misclassified
   * as bank-link (or vice versa).
   *
   * Idempotent: an attempt not currently `pending` is a safe no-op (an AUTHORISATION webhook
   * redelivery, or one arriving after the attempt already progressed) — but STILL reports `true`,
   * since the reference itself is still recognizably ours on every redelivery, not only the first.
   */
  async recordAuthorisationConfirmed(input: { merchantReference: string; pspReference: string; success: boolean }): Promise<boolean> {
    const attempt = await this.deps.bankLinkAttempts.findByMerchantReference(input.merchantReference);
    if (!attempt) return false;
    if (attempt.status !== "pending") return true;
    if (input.success) {
      await this.deps.bankLinkAttempts.markAuthorised(attempt.id, input.pspReference, new Date());
    } else {
      await this.deps.bankLinkAttempts.markFailed(attempt.id);
    }
    return true;
  }

  /**
   * PAID2YOU — B0-D ADYEN PHASE 2A: called ONLY by the Recurring-tokens-lifecycle webhook route for
   * `recurring.token.created`/`recurring.token.alreadyExisting` (identical handling for both — see
   * this class's own doc comment, step 3, and `AdyenTokenLifecycleService`'s doc comment for exactly
   * why `alreadyExisting` is not itself a security concern). Throws a retryable `ValidationError` when
   * no "authorised" row matches yet — the AUTHORISATION webhook may simply not have been processed
   * yet; the caller must NOT swallow this as success, and Adyen's own webhook redelivery is the
   * intended retry mechanism (no bespoke retry table is introduced here).
   */
  async completeFromTokenEvent(input: {
    pspReference: string;
    shopperReference: string;
    storedPaymentMethodId: string;
    merchantAccount: string;
  }): Promise<void> {
    if (input.merchantAccount !== this.deps.adyenMerchantAccount) {
      logger.error("bank_link_token_event_wrong_merchant_account", { expected: this.deps.adyenMerchantAccount, received: input.merchantAccount });
      return; // not ours — never an error, never processed.
    }
    const attempt = await this.deps.bankLinkAttempts.findByConfirmedPspReference(input.pspReference);
    if (!attempt) {
      throw new ValidationError(
        "No authorised bank-link attempt matches this token event's pspReference yet — the corresponding AUTHORISATION webhook may not have been processed. Retryable.",
      );
    }
    if (attempt.status === "completed") return; // idempotent — already processed (redelivery).
    if (attempt.status !== "authorised") {
      // Genuinely unexpected (e.g. the row expired/failed between AUTHORISATION and the token event) —
      // never silently complete a row outside its own legal lifecycle; not retryable either, since
      // re-delivery will find the exact same (non-"authorised") state.
      logger.error("bank_link_token_event_unexpected_attempt_status", { attemptId: attempt.id, status: attempt.status });
      return;
    }
    if (attempt.shopperReference !== input.shopperReference) {
      // Should be structurally impossible given the merchantReference/pspReference identity chain —
      // refuse rather than ever misattribute a token to the wrong shopper.
      throw new ConfigurationError("bank_link_attempt_shopper_reference_mismatch");
    }

    const partyId = attempt.partyProfileKind === "personal" ? attempt.partyIndividualProfileId : attempt.partyOrganizationId;
    if (!partyId) throw new ConfigurationError("bank_link_attempt missing its own party id.");

    const account = await this.deps.financialAccounts.addAccount({
      actingUserId: attempt.actingUserId,
      actingParty: { kind: attempt.partyProfileKind, id: partyId },
      accountType: "bank_account",
      providerName: this.deps.provider.providerName,
      providerAccountRef: input.storedPaymentMethodId,
      // Adyen's tokenization webhooks do not surface a masked account number/checking-vs-savings
      // distinction — never guessed; the token event's `data` object contains no such field.
      maskedLast4: null,
      institutionDisplayName: attempt.institutionDisplayName,
      bankAccountSubtype: null,
    });
    const verified = account.status === "pending_verification" ? await this.deps.financialAccounts.applyVerificationResult(account.id, "verified") : account;
    await this.deps.bankLinkAttempts.markCompleted(attempt.id, verified.id, new Date());
  }

  private requireAttemptBelongsToParty(
    attempt: { actingUserId: string; partyProfileKind: PartyRef["kind"]; partyIndividualProfileId: string | null; partyOrganizationId: string | null },
    actingUserId: string,
    actingParty: PartyRef,
  ): void {
    const attemptPartyId = attempt.partyProfileKind === "personal" ? attempt.partyIndividualProfileId : attempt.partyOrganizationId;
    if (attempt.actingUserId !== actingUserId || attempt.partyProfileKind !== actingParty.kind || attemptPartyId !== actingParty.id) {
      throw new ForbiddenError("This bank-connection attempt does not belong to the specified party.");
    }
  }
}
