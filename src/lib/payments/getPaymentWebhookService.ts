import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzlePaymentAttemptRepository } from "./drizzlePaymentAttemptRepository";
import { DrizzlePaymentWebhookEventRepository } from "./drizzlePaymentWebhookEventRepository";
import { getPaymentProvider } from "./getPaymentProvider";
import { PaymentWebhookService } from "./paymentWebhookService";

let cached: PaymentWebhookService | null = null;

export function getPaymentWebhookService(): PaymentWebhookService {
  if (!cached) {
    cached = new PaymentWebhookService({
      provider: getPaymentProvider(),
      events: new DrizzlePaymentWebhookEventRepository(),
      payments: new DrizzlePaymentAttemptRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
