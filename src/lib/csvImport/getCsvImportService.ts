import "server-only";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getStaffService } from "@/lib/staff/getStaffService";
import { CsvImportService } from "./csvImportService";
import { DrizzleCsvImportBatchRepository } from "./drizzleCsvImportBatchRepository";
import { DrizzleCsvImportRowRepository } from "./drizzleCsvImportRowRepository";
import { DrizzleCustomerAccountResolver } from "./drizzleCustomerAccountResolver";
import { DrizzleExistingAgreementDuplicateChecker } from "./drizzleExistingAgreementDuplicateChecker";

let cached: CsvImportService | null = null;

/** Lazily creates (and memoizes) the production CsvImportService. Mirrors getSignatureService.ts's pattern. */
export function getCsvImportService(): CsvImportService {
  if (!cached) {
    cached = new CsvImportService({
      agreementService: getAgreementService(),
      staffService: getStaffService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      batches: new DrizzleCsvImportBatchRepository(),
      rows: new DrizzleCsvImportRowRepository(),
      duplicateChecker: new DrizzleExistingAgreementDuplicateChecker(),
      accountResolver: new DrizzleCustomerAccountResolver(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
