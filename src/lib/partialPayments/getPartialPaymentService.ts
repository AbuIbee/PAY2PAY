import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzlePartialPaymentRepository } from "./drizzlePartialPaymentRepository";
import { PartialPaymentService } from "./partialPaymentService";

let cached: PartialPaymentService | null = null;

export function getPartialPaymentService(): PartialPaymentService {
  if (!cached) {
    cached = new PartialPaymentService({
      agreementService: getAgreementService(),
      requests: new DrizzlePartialPaymentRepository(),
      payments: new DrizzlePaymentAttemptRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
