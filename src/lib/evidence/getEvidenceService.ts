import "server-only";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementWitnessRepository } from "./drizzleAgreementWitnessRepository";
import { DrizzleEvidenceRepository } from "./drizzleEvidenceRepository";
import { EvidenceService } from "./evidenceService";
import { BasicFileValidator } from "./fileValidator";
import { getEvidenceStorage } from "./getEvidenceStorage";
import { WitnessReaderAdapter } from "./witnessReaderAdapter";

let cached: EvidenceService | null = null;

/** Lazily creates (and memoizes) the production EvidenceService. Mirrors getSignatureService.ts's pattern. */
export function getEvidenceService(): EvidenceService {
  if (!cached) {
    cached = new EvidenceService({
      agreementService: getAgreementService(),
      evidence: new DrizzleEvidenceRepository(),
      witnesses: new WitnessReaderAdapter(new DrizzleAgreementWitnessRepository()),
      storage: getEvidenceStorage(),
      fileValidator: new BasicFileValidator(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
