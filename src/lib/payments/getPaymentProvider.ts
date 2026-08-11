import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { SandboxPaymentProvider } from "./sandboxPaymentProvider";
import type { PaymentProvider } from "./paymentProvider";

let cached: SandboxPaymentProvider | null = null;

/**
 * Sprint 9: the only PaymentProvider wired up in this codebase — sandbox only, per "NO PRODUCTION
 * MONEY." A real Stripe Connect/Plaid adapter (Sprint 11/12) would get its own getXProvider() and a
 * runtime switch here driven by configuration, without any change to PaymentService.
 */
export function getPaymentProvider(): PaymentProvider {
  if (!cached) {
    const { PAYMENT_SANDBOX_WEBHOOK_SECRET } = getServerEnv();
    if (!PAYMENT_SANDBOX_WEBHOOK_SECRET) {
      throw new ConfigurationError("PAYMENT_SANDBOX_WEBHOOK_SECRET is not configured.");
    }
    cached = new SandboxPaymentProvider(PAYMENT_SANDBOX_WEBHOOK_SECRET);
  }
  return cached;
}

/** Test/internal-only accessor to the concrete sandbox instance (e.g. to call simulateSettlement). */
export function getSandboxPaymentProviderInstance(): SandboxPaymentProvider {
  return getPaymentProvider() as SandboxPaymentProvider;
}
