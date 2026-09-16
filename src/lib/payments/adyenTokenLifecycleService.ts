import "server-only";
import type { AchMandateService } from "@/lib/ach/achMandateService";
import type { BankConnectionService } from "@/lib/relationships/bankConnectionService";
import type { RelationshipFinancialAccountService } from "@/lib/relationships/relationshipFinancialAccountService";
import type { AdyenTokenLifecycleEvent } from "./adyenPaymentProvider";

/**
 * PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction, items 1 & 2). The ONLY consumer of
 * Adyen's "Recurring tokens life cycle events" webhook (`recurring.token.created`/
 * `recurring.token.alreadyExisting`/`recurring.token.disabled` — see `AdyenPaymentProvider`'s own
 * module doc comment for exactly how that webhook is verified/parsed).
 *
 * `created`/`alreadyExisting` are handled IDENTICALLY — both delegate to
 * `BankConnectionService.completeFromTokenEvent`, which is the sole place the Adyen-authenticated
 * correlation chain (merchantReference -> AUTHORISATION pspReference -> token event's own matching
 * pspReference/shopperReference/merchantAccount) is verified before a `financial_account` is ever
 * persisted — see that method's own doc comment. `alreadyExisting` fires when Adyen recognizes the
 * shopper's bank details as matching a token it already issued for that EXACT shopperReference — this
 * is never a cross-user event (Adyen's own shopperReference scoping is the tenant boundary; a
 * different shopperReference can never receive `alreadyExisting` for someone else's token) — it is
 * simply "reuse of this shopper's own prior token," which
 * `RelationshipFinancialAccountService.addAccount`'s own existing duplicate-provisioning protection
 * already handles idempotently (returns the existing row rather than inserting a second one).
 *
 * `disabled` is the concrete mechanism behind "a disabled Adyen token must become unusable for future
 * Paid2You payments": marking `financial_account.status = "disabled"` alone is NOT sufficient, because
 * `PaymentService.submitToProvider` never reads `financial_account` directly — it reads the
 * agreement's own `ach_mandate.bank_account_ref` (via `DrizzleAchMandateProviderRefReader`). So this
 * handler ALSO revokes every currently-active mandate referencing the same token
 * (`AchMandateService.revokeAllForBankAccountRef`) — without that second step, a "disabled" account
 * would still silently back live payment attempts until they failed at Adyen, not before.
 *
 * Idempotent throughout: `completeFromTokenEvent` no-ops on an already-`completed` attempt;
 * `disableAccountByProviderRef`/`revokeAllForBankAccountRef` no-op on an already-disabled/revoked
 * target — a redelivered webhook of any of these three event types is always safe to reprocess.
 */
export class AdyenTokenLifecycleService {
  constructor(
    private readonly deps: {
      bankConnections: BankConnectionService;
      financialAccounts: RelationshipFinancialAccountService;
      achMandates: AchMandateService;
      providerName: string;
    },
  ) {}

  async handleEvent(event: AdyenTokenLifecycleEvent): Promise<void> {
    if (event.eventType === "recurring.token.created" || event.eventType === "recurring.token.alreadyExisting") {
      await this.deps.bankConnections.completeFromTokenEvent({
        pspReference: event.pspReference,
        shopperReference: event.shopperReference,
        storedPaymentMethodId: event.storedPaymentMethodId,
        merchantAccount: event.merchantAccount,
      });
      return;
    }
    if (event.eventType !== "recurring.token.disabled") return; // updated: informational only.
    const account = await this.deps.financialAccounts.disableAccountByProviderRef(
      this.deps.providerName,
      event.storedPaymentMethodId,
      "Disabled by the payment provider (recurring.token.disabled).",
    );
    if (!account) return; // A token this Paid2You instance never tokenized — not a failure.
    await this.deps.achMandates.revokeAllForBankAccountRef(
      event.storedPaymentMethodId,
      "The underlying bank account token was disabled by the payment provider.",
    );
  }
}
