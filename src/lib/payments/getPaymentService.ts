import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import { DrizzlePaymentAttemptRepository } from "./drizzlePaymentAttemptRepository";
import { getPaymentProvider } from "./getPaymentProvider";
import { PaymentService } from "./paymentService";

let cached: PaymentService | null = null;

export function getPaymentService(): PaymentService {
  if (!cached) {
    cached = new PaymentService({
      provider: getPaymentProvider(),
      verification: getVerificationService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      payments: new DrizzlePaymentAttemptRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
