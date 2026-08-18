import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { AgreementCompletionService } from "./agreementCompletionService";
import { getBalanceService } from "./getBalanceService";

let cached: AgreementCompletionService | null = null;

export function getAgreementCompletionService(): AgreementCompletionService {
  if (!cached) {
    cached = new AgreementCompletionService({
      agreements: new DrizzleAgreementRepository(),
      balances: getBalanceService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
