import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { AchMandateService } from "./achMandateService";
import { DrizzleAchMandateRepository } from "./drizzleAchMandateRepository";

let cached: AchMandateService | null = null;

export function getAchMandateService(): AchMandateService {
  if (!cached) {
    cached = new AchMandateService({
      mandates: new DrizzleAchMandateRepository(),
      profileOwners: new DrizzleProfileOwnerReader(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
