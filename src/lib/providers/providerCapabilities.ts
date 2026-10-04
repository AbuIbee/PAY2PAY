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
 * PAID2YOU OWNER DIRECTIVE (2026-10-03) — ADYEN RETIRED: `adyen` was registered here from B0-D ADYEN
 * PHASE 1/2 through "PAID2YOU PRODUCTION LAUNCH" Phase 2. The Paid2You owner has since retired Adyen
 * from the architecture outright: "Adyen may not be reintroduced under any circumstance without
 * explicit written authorization from the Paid2You owner." `PROVIDER_CAPABILITY_REGISTRY` is EMPTY
 * again as of this directive — exactly the same "two-outcome, never a third" invariant this file's
 * own module doc comment already states applies: nothing registered -> `assertProviderAvailableForRuntime`
 * always throws `ProviderNotAvailableError` for `PAYMENT_PROVIDER=adyen` (or any other value) in every
 * environment, including production. `AdyenPaymentProvider` and its surrounding adapter code are left
 * in place as retired/legacy material (never deleted outright this directive — "treated as legacy/
 * dead integration material unless explicitly required for safe removal or compatibility analysis")
 * but are now structurally UNREACHABLE from any production code path: no name resolves to them.
 *
 * The owner-approved direction going forward: repayment money movement is DIRECT BANKING CONNECTIVITY
 * (FedNow / RTP / Request for Payment — Phase 3B, not yet implemented); Paid2You's OWN subscription
 * billing is Stripe Billing (separate domain, src/lib/organizations/platformBillingProvider.ts, not
 * yet implemented); Business verification is Middesk (src/lib/organizations/businessVerificationProvider.ts,
 * not yet implemented). None of these may be implemented, configured, or treated as the production
 * direction without an explicit, detailed implementation directive — naming a vendor here is not
 * itself that directive. Sandbox/mock provider implementations remain permanently absent from this
 * registry and from all production runtime paths (see this file's own module doc comment above) —
 * that invariant is unaffected by any of the above and remains independently enforced by
 * `scripts/check-no-sandbox-runtime.mjs`. Adding a real provider later remains additive and requires
 * no change to this file's *shape*: a new descriptor entry here, a new adapter class implementing the
 * relevant interface, and a matching PAYMENT_PROVIDER/KYC_PROVIDER/CARD_ISSUING_PROVIDER value in
 * src/config/env.ts — never autonomously, only once explicitly directed.
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

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 9/10: `business_verification` and
 * `platform_billing` reuse this exact same registry/gate mechanism and error semantics — a
 * business-verification or platform-billing provider is either a registered, live
 * (`environment: "production"`) descriptor, or `assertProviderAvailableForRuntime` throws
 * `ProviderNotAvailableError`, never a sandbox fallback. Neither has a registered descriptor below
 * (no real provider is configured for either), so both factories (getBusinessVerificationProvider.ts/
 * getPlatformBillingProvider.ts) fail closed exactly like getKycProvider.ts does today.
 */
export type ProviderKind = "payment" | "kyc" | "card_issuing" | "business_verification" | "platform_billing";

const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  payment: "payment provider",
  kyc: "KYC/KYB provider",
  card_issuing: "card-issuing provider",
  business_verification: "business verification provider",
  platform_billing: "platform billing provider",
};

/**
 * Do not add a sandbox/mock/demo/test entry here under any circumstance — see this file's module doc
 * comment. Only real, approved, `environment: "production"` adapters belong here.
 *
 * PAID2YOU OWNER DIRECTIVE (2026-10-03) — ADYEN RETIRED: `adyen` was registered here from B0-D ADYEN
 * PHASE 1 through "PAID2YOU PRODUCTION LAUNCH" Phase 2, then retired outright — see this file's own
 * module doc comment above. It is NOT re-added below, and may never be, without a separate, explicit,
 * written, owner-authorized directive.
 *
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 10/17: the owner-approved `middesk` (Business
 * verification) and `stripe` (Paid2You's OWN subscription billing — NEVER customer repayment)
 * descriptors below are the first two real entries this registry has ever held for the
 * `business_verification`/`platform_billing` kinds. Each is registered ONLY for its own proper
 * capability/kind — Middesk is never treated as a payment provider, Stripe is never treated as (or
 * reachable from) the customer-repayment/`payment` kind. Direct Banking (FedNow/RTP/Request for
 * Payment) — the approved customer-repayment direction — has NO entry here; it is not implemented in
 * this worktree (see docs/PRODUCTION_PROVIDER_READINESS.md's FULL_MONEY_MOVEMENT section) and must
 * never be satisfied by registering Stripe (or any other non-direct-banking provider) under the
 * `payment` kind as a substitute.
 */
export const PROVIDER_CAPABILITY_REGISTRY: Readonly<Record<string, ProviderCapabilityDescriptor>> = {
  middesk: { providerName: "middesk", environment: "production", capabilities: ["kyb"] },
  stripe: { providerName: "stripe", environment: "production", capabilities: ["webhook_delivery"] },
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
