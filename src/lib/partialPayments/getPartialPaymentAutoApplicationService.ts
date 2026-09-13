import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzlePaymentRetryRepository } from "@/lib/failedPayments/drizzlePaymentRetryRepository";
import { getLedgerService } from "@/lib/ledger/getLedgerService";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzlePartialPaymentRepository } from "./drizzlePartialPaymentRepository";
import { PartialPaymentAutoApplicationService } from "./partialPaymentAutoApplicationService";

let cached: PartialPaymentAutoApplicationService | null = null;

export function getPartialPaymentAutoApplicationService(): PartialPaymentAutoApplicationService {
  if (!cached) {
    cached = new PartialPaymentAutoApplicationService({
      requests: new DrizzlePartialPaymentRepository(),
      payments: new DrizzlePaymentAttemptRepository(),
      retries: new DrizzlePaymentRetryRepository(),
      ledger: getLedgerService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
