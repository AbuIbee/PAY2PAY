import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { BusinessProfileService } from "./businessProfileService";
import { DrizzleBusinessProfileRepository } from "./drizzleBusinessProfileRepository";

let cached: BusinessProfileService | null = null;

export function getBusinessProfileService(): BusinessProfileService {
  if (!cached) {
    cached = new BusinessProfileService(
      new DrizzleBusinessProfileRepository(),
      new AuditService(new DrizzleAuditEventRepository()),
    );
  }
  return cached;
}
