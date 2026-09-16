import "server-only";
import { ConfigurationError, ProviderNotAvailableError } from "@/lib/errors";

/**
 * PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION.
 *
 * This registry previously (PRSprint 21) held sandbox/mock descriptors for payments, KYC/KYB, and
 * card issuing, and a one-directional consistency check that explicitly *permitted* those sandbox
 * descriptors to run inside a production deployment ("sandbox-in-production is explicitly permitted
 * architecture pending live provider approval"). The 2026-09-15 B0-D production-gate audit found that
 * permission itself to be the release blocker: every financial/KYC/card operation in production ran
 * against an inert sandbox simulator, with no customer-facing disclosure, which the audit could not
 * reconcile with a "0 production-reachable sandbox implementations" release bar.
 *
 * This file now enforces the opposite invariant. There are exactly two runtime outcomes for any
 * capability (payment / KYC / card issuing) — never a third:
 *
 *   1. A LIVE provider is registered here (`environment: "production"`) AND the requested name
 *      resolves to it -> the provider may be constructed.
 *   2. Anything else (nothing registered, an unknown name, "sandbox"/"mock"/any other non-live
 *      value, or an unset env var) -> `assertProviderAvailableForRuntime` throws
 *      `ProviderNotAvailableError`. There is no sandbox fallback branch to fall into.
 *
 * `PROVIDER_CAPABILITY_REGISTRY` is empty today because no live provider has been selected/approved
 * (see docs/PRODUCTION_PROVIDER_READINESS.md) — B-1 remains on hard hold. Adding a real provider later
 * is still additive and requires no change to this file's *shape*: a new descriptor entry here, a new
 * adapter class implementing the relevant interface, and a matching
 * PAYMENT_PROVIDER/KYC_PROVIDER/CARD_ISSUING_PROVIDER value in src/config/env.ts.
 *
 * Sandbox/mock provider *implementations* (SandboxPaymentProvider, SandboxKycProvider,
 * SandboxCardIssuingProvider) still exist, but only as test doubles under src/test-support/ — they are
 * never imported from this file, the three getXProvider() factories, or any other production runtime
 * path, and are never registered here.
 */
export type ProviderEnvironment = "production";

export type FinancialProviderCapability =
  | "kyc"
  | "kyb"
  | "bank_linking"
  | "ach_debit"
  | "ach_credit"
  | "virtual_account_creation"
  | "debit_card_issuing"
  | "webhook_delivery"
  | "transaction_reconciliation";

export interface ProviderCapabilityDescriptor {
  readonly providerName: string;
  readonly environment: ProviderEnvironment;
  readonly capabilities: readonly FinancialProviderCapability[];
}

export type ProviderKind = "payment" | "kyc" | "card_issuing";

const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  payment: "payment provider",
  kyc: "KYC/KYB provider",
  card_issuing: "card-issuing provider",
};

/**
 * Do not add a sandbox/mock/demo/test entry here under any circumstance — see this file's module doc
 * comment. Only real, approved, `environment: "production"` adapters belong here.
 *
 * PAID2YOU — B0-D ADYEN PHASE 1: `adyen` is registered here as the selected production payment
 * provider. Its capabilities are declared narrowly, matching exactly what
 * `src/lib/payments/adyenPaymentProvider.ts` actually implements this phase — `ach_debit` (debtor-side
 * ACH Direct Debit charging via the Payments API) and `webhook_delivery` (standard payment
 * notifications). PHASE 2 additionally declares `bank_linking` (bank-account collection/tokenization
 * via Adyen's Sessions API + Web Component — `createBankAccountSession`/`disableStoredPaymentMethod`,
 * plus the PHASE 2A webhook-only correlation chain in `BankConnectionService`). Deliberately still NOT declared: `ach_credit`/
 * `virtual_account_creation` (payout — Balance Platform + Transfers API, a later phase), `kyc`/`kyb`
 * (Legal Entity Management, a later phase), `debit_card_issuing` (not planned — see the B0-D Adyen
 * gap-map's card-issuing determination), and `transaction_reconciliation`
 * (`retrievePayment`/`retrievePaymentByIdempotencyKey` are not implementable against Adyen's actual
 * API surface — see that file's own module doc comment, item 1).
 */
export const PROVIDER_CAPABILITY_REGISTRY: Readonly<Record<string, ProviderCapabilityDescriptor>> = {
  adyen: {
    providerName: "adyen",
    environment: "production",
    capabilities: ["ach_debit", "webhook_delivery", "bank_linking"],
  },
};

/** Returns the descriptor for a registered provider name, or `null` if none is registered under that name (including when `providerName` is undefined/empty). Never throws — callers that need a hard failure should use `assertProviderAvailableForRuntime` instead. */
export function findProviderCapabilityDescriptor(providerName: string | undefined): ProviderCapabilityDescriptor | null {
  if (!providerName) return null;
  return PROVIDER_CAPABILITY_REGISTRY[providerName] ?? null;
}

export function providerSupportsCapability(descriptor: ProviderCapabilityDescriptor, capability: FinancialProviderCapability): boolean {
  return descriptor.capabilities.includes(capability);
}

/**
 * The single centralized fail-closed gate every provider factory (getPaymentProvider/getKycProvider/
 * getCardIssuingProvider) calls before constructing anything. Two outcomes only:
 *
 *   - `providerName` resolves to a registered, `environment: "production"` descriptor, AND this
 *     process is genuinely running with `APP_ENV === "production"` -> returns the descriptor.
 *   - Anything else -> throws. An unregistered/unknown/sandbox name throws
 *     `ProviderNotAvailableError` (503, "feature not available" — the expected, operator-visible
 *     state today). A registered *production* provider being constructed outside a genuine production
 *     deployment throws `ConfigurationError` (500, a real misconfiguration/bug) — the one case that
 *     indicates something is wired wrong rather than "not available yet".
 */
export function assertProviderAvailableForRuntime(kind: ProviderKind, providerName: string | undefined, appEnv: string): ProviderCapabilityDescriptor {
  const descriptor = findProviderCapabilityDescriptor(providerName);
  if (!descriptor) {
    throw new ProviderNotAvailableError(
      `No live ${PROVIDER_KIND_LABEL[kind]} is configured. This feature is not available until a live provider is approved and configured (see docs/PRODUCTION_PROVIDER_READINESS.md).`,
    );
  }
  if (descriptor.environment === "production" && appEnv !== "production") {
    throw new ConfigurationError(
      `Provider "${descriptor.providerName}" is a production financial provider and cannot be constructed outside the production environment (current APP_ENV: "${appEnv}").`,
    );
  }
  return descriptor;
}
