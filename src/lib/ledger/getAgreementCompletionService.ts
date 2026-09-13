import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { AgreementCompletionService } from "./agreementCompletionService";
import { DrizzleAgreementInstallmentSatisfactionReader } from "./drizzleAgreementInstallmentSatisfactionReader";
import { DrizzleAtomicAgreementCompletionDecider } from "./drizzleAtomicAgreementCompletionDecider";
import { getBalanceService } from "./getBalanceService";

let cached: AgreementCompletionService | null = null;

export function getAgreementCompletionService(): AgreementCompletionService {
  if (!cached) {
    cached = new AgreementCompletionService({
      agreements: new DrizzleAgreementRepository(),
      balances: getBalanceService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      installmentSatisfaction: new DrizzleAgreementInstallmentSatisfactionReader(),
      // R11 CORRECTION PASS A (Defect A4): see `AtomicAgreementCompletionDecider`'s own doc comment.
      atomicCompletion: new DrizzleAtomicAgreementCompletionDecider(),
    });
  }
  return cached;
}
