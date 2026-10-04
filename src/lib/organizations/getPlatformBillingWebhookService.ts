import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import { DrizzleSubscriptionInvoiceRepository } from "./drizzleSubscriptionInvoiceRepository";
import { DrizzleSubscriptionPaymentMethodRepository } from "./drizzleSubscriptionPaymentMethodRepository";
import { DrizzleSubscriptionRepository } from "@/lib/pricing/drizzleSubscriptionRepository";
import { DrizzlePlatformBillingWebhookEventRepository } from "./drizzlePlatformBillingWebhookEventRepository";
import { getPlatformBillingProvider } from "./getPlatformBillingProvider";
import { PlatformBillingWebhookService } from "./platformBillingWebhookService";

let cached: PlatformBillingWebhookService | null = null;

/**
 * Mirrors getKycWebhookService.ts's identical "construct lazily, fail closed at the point of use"
 * pattern — this intentionally calls `getPlatformBillingProvider()` (the EAGER, throwing factory),
 * NOT `getLazyPlatformBillingProvider()`: a webhook can only ever legitimately arrive once a real
 * provider is actually configured (there is no "local-first, provider-independent" webhook
 * operation, unlike cancel/reactivate), so this factory should fail closed immediately rather than
 * defer that failure.
 */
export function getPlatformBillingWebhookService(): PlatformBillingWebhookService {
  if (!cached) {
    cached = new PlatformBillingWebhookService({
      provider: getPlatformBillingProvider(),
      events: new DrizzlePlatformBillingWebhookEventRepository(),
      subscriptions: new DrizzleSubscriptionRepository(),
      invoices: new DrizzleSubscriptionInvoiceRepository(),
      paymentMethods: new DrizzleSubscriptionPaymentMethodRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      businessProfiles: new DrizzleBusinessProfileRepository(),
    });
  }
  return cached;
}
