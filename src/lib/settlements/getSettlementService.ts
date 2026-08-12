import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { getMfaService } from "@/lib/auth/getMfaService";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzleSettlementPaymentRepository, DrizzleSettlementRepository } from "./drizzleSettlementRepository";
import { SettlementService } from "./settlementService";

let cached: SettlementService | null = null;

export function getSettlementService(): SettlementService {
  if (!cached) {
    cached = new SettlementService({
      agreementService: getAgreementService(),
      agreements: new DrizzleAgreementRepository(),
      proposals: new DrizzleSettlementRepository(),
      settlementPayments: new DrizzleSettlementPaymentRepository(),
      payments: new DrizzlePaymentAttemptRepository(),
      mfa: getMfaService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
