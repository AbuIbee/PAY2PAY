import "server-only";
import { getMfaService } from "@/lib/auth/getMfaService";
import { getPaymentProvider } from "@/lib/payments/getPaymentProvider";
import { assertProviderAvailableForRuntime, providerSupportsCapability } from "@/lib/providers/providerCapabilities";
import { getServerEnv } from "@/config/env";
import { ConfigurationError, ProviderNotAvailableError } from "@/lib/errors";
import { BankConnectionService } from "./bankConnectionService";
import { DrizzleBankLinkAttemptRepository } from "./drizzleBankLinkAttemptRepository";
import { getRelationshipFinancialAccountService } from "./getRelationshipFinancialAccountService";

let cached: BankConnectionService | null = null;

/**
 * Lazily creates (and memoizes) the production BankConnectionService. Reuses the same PaymentProvider
 * payments/ACH already resolve through — no separate provider registry entry for bank-linking.
 *
 * PAID2YOU — B0-D ADYEN PHASE 2: additionally asserts the resolved provider's own registered
 * capabilities actually include `bank_linking` (src/lib/providers/providerCapabilities.ts) — defense
 * in depth beyond `getPaymentProvider()`'s own general availability check, so a future provider
 * registered for payments-only (capabilities not yet including bank-linking) fails closed here with a
 * clear, typed `ProviderNotAvailableError` rather than reaching `AdyenPaymentProvider`-specific method
 * stubs that throw a plain, less-actionable `Error`.
 *
 * PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction, item 3 — EXTERNAL BLOCKER):
 * additionally requires `ADYEN_ACH_TOKENIZATION_VERIFIED=true` — see that env var's own doc comment
 * (src/config/env.ts) for exactly why. Defaults to `false`, so bank-linking stays unavailable
 * (`ProviderNotAvailableError`, the same "not yet available" state the UI already renders) until an
 * operator explicitly confirms with Adyen that zero-value ACH authorization + GIACT verification are
 * active for the real production merchant account. Never bypassed, never assumed.
 */
export function getBankConnectionService(): BankConnectionService {
  if (!cached) {
    const provider = getPaymentProvider();
    const env = getServerEnv();
    const descriptor = assertProviderAvailableForRuntime("payment", env.PAYMENT_PROVIDER, env.APP_ENV);
    if (!providerSupportsCapability(descriptor, "bank_linking")) {
      throw new ProviderNotAvailableError(`Provider "${descriptor.providerName}" does not support bank-account linking.`);
    }
    if (!env.ADYEN_ACH_TOKENIZATION_VERIFIED) {
      throw new ProviderNotAvailableError(
        "Bank-account linking requires ADYEN_ACH_TOKENIZATION_VERIFIED=true — Adyen zero-value ACH authorization and GIACT verification must be confirmed active for this merchant account (an external, Adyen-side capability this codebase cannot verify itself) before this feature may be enabled.",
      );
    }
    if (!env.ADYEN_MERCHANT_ACCOUNT) {
      // Unreachable in practice — getPaymentProvider() above already requires this to construct a
      // real "adyen" provider — but never silently trust that invariant for a value used in a
      // security-relevant equality check (BankConnectionService.completeFromTokenEvent).
      throw new ConfigurationError("ADYEN_MERCHANT_ACCOUNT is required to wire BankConnectionService.");
    }
    cached = new BankConnectionService({
      provider,
      financialAccounts: getRelationshipFinancialAccountService(),
      bankLinkAttempts: new DrizzleBankLinkAttemptRepository(),
      mfa: getMfaService(),
      adyenMerchantAccount: env.ADYEN_MERCHANT_ACCOUNT,
    });
  }
  return cached;
}

/**
 * PAID2YOU — B0-D ADYEN PHASE 2A: non-throwing variant for the payment webhook route's own
 * best-effort bank-link correlation pass (`/api/payments/webhook/route.ts`) — that route must always
 * keep processing ordinary payment webhooks correctly regardless of whether bank-linking happens to be
 * unavailable/gated off (in which case there are, by construction, no pending `bank_link_attempt` rows
 * to correlate against, so skipping the pass entirely is always correct). Never used by the actual
 * bank-linking routes themselves — those must fail loudly via `getBankConnectionService()` above.
 */
export function getBankConnectionServiceIfAvailable(): BankConnectionService | null {
  try {
    return getBankConnectionService();
  } catch {
    return null;
  }
}
