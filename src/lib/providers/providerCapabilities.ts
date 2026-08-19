import "server-only";
import { ConfigurationError } from "@/lib/errors";

/**
 * PRSprint 21 (docs/prsprints/PRSPRINT_21_PRODUCTION_FINANCIAL_PROVIDER_ARCHITECTURE.md): the
 * formal provider-capability model this PRSprint's Detailed Scope requires. Every financial-provider
 * concept in this codebase (PaymentProvider, KycKybProvider, and any future CardIssuingProvider) has
 * an interface consumers depend on already (Sprint 9) — what was missing is a single place that
 * declares, for each *registered implementation* of those interfaces, which of the capabilities the
 * PAY2PAY domain actually needs it supports, and which environment (sandbox vs. production) it runs
 * in. "Do not assume every future provider supports every capability" (this PRSprint's own text) is
 * the reason this is a declared list per provider, not an assumed blanket "yes."
 */
export type ProviderEnvironment = "sandbox" | "production";

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
 * One entry per registered provider implementation — keyed by the same `providerName` string every
 * provider class already exposes (`SandboxPaymentProvider.providerName`, etc.), so this registry can
 * never drift out of sync with which classes actually exist. Extending this to a real provider is
 * additive: add its descriptor here, add its name to the `PAYMENT_PROVIDER`/`KYC_PROVIDER` env enum
 * (src/config/env.ts), and register its factory in getPaymentProvider.ts/getKycProvider.ts — no
 * change to PaymentService, KycVerificationService, or any other consumer.
 */
export const PROVIDER_CAPABILITY_REGISTRY: Readonly<Record<string, ProviderCapabilityDescriptor>> = {
  sandbox_mock: {
    providerName: "sandbox_mock",
    environment: "sandbox",
    capabilities: ["ach_debit", "ach_credit", "webhook_delivery", "transaction_reconciliation"],
  },
  sandbox_kyc_mock: {
    providerName: "sandbox_kyc_mock",
    environment: "sandbox",
    capabilities: ["kyc", "kyb", "webhook_delivery"],
  },
  // PRSprint 24 (docs/prsprints/PRSPRINT_24_DEBIT_CARD_ISSUANCE_CARD_LIFECYCLE.md).
  sandbox_card_issuing_mock: {
    providerName: "sandbox_card_issuing_mock",
    environment: "sandbox",
    capabilities: ["debit_card_issuing", "webhook_delivery"],
  },
};

export function getProviderCapabilityDescriptor(providerName: string): ProviderCapabilityDescriptor {
  const descriptor = PROVIDER_CAPABILITY_REGISTRY[providerName];
  if (!descriptor) {
    throw new ConfigurationError(`No capability descriptor is registered for provider "${providerName}".`);
  }
  return descriptor;
}

export function providerSupportsCapability(descriptor: ProviderCapabilityDescriptor, capability: FinancialProviderCapability): boolean {
  return descriptor.capabilities.includes(capability);
}

/**
 * Environment separation (this PRSprint's own required section): "Production endpoints must not
 * accept sandbox credentials. Sandbox endpoints must not accidentally trigger production
 * operations." Concretely enforced here as the one rule that actually matters for correctness: a
 * provider tagged `environment: "production"` — meaning it is capable of moving real money or
 * submitting real verification data — must never be constructed outside a genuine production
 * deployment (`APP_ENV === "production"`). The reverse (a sandbox provider running inside a
 * production deployment) is today's actual, correct state — sandbox-in-production is explicitly
 * permitted architecture pending live provider approval (Hard Stop rule: mark it EXTERNAL BLOCKER,
 * never represent it as live), not an error to throw on. This function is therefore intentionally
 * one-directional.
 */
export function assertProviderEnvironmentConsistency(descriptor: ProviderCapabilityDescriptor, appEnv: string): void {
  if (descriptor.environment === "production" && appEnv !== "production") {
    throw new ConfigurationError(
      `Provider "${descriptor.providerName}" is a production financial provider and cannot be constructed outside the production environment (current APP_ENV: "${appEnv}").`,
    );
  }
}
