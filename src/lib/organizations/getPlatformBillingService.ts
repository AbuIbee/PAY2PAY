import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzlePricingPlanRepository } from "@/lib/pricing/drizzlePricingPlanRepository";
import { DrizzleSubscriptionRepository } from "@/lib/pricing/drizzleSubscriptionRepository";
import { DrizzleSubscriptionInvoiceRepository } from "./drizzleSubscriptionInvoiceRepository";
import { DrizzleSubscriptionPaymentMethodRepository } from "./drizzleSubscriptionPaymentMethodRepository";
import { getLazyPlatformBillingProvider } from "./getPlatformBillingProvider";
import { PlatformBillingService } from "./platformBillingService";

let cached: PlatformBillingService | null = null;

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 10, corrected by "PAID2YOU PRODUCTION LAUNCH"
 * Phase 2 Section 16: injects `getLazyPlatformBillingProvider()` — see that function's own doc
 * comment for why this service must be constructible, and its local-first methods
 * (`cancelAtPeriodEnd`/`reactivate`) actually callable, even when no live provider is configured.
 * `getPlatformBillingProvider()` throws `ProviderNotAvailableError` today (no provider registered) —
 * that is now surfaced at first actual provider USE, not at this factory call.
 */
export function getPlatformBillingService(): PlatformBillingService {
  if (!cached) {
    cached = new PlatformBillingService(
      getLazyPlatformBillingProvider(),
      new DrizzleSubscriptionRepository(),
      new DrizzlePricingPlanRepository(),
      new DrizzleSubscriptionInvoiceRepository(),
      new DrizzleSubscriptionPaymentMethodRepository(),
      new AuditService(new DrizzleAuditEventRepository()),
    );
  }
  return cached;
}
