import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAtomicBusinessProfileCreator } from "./atomicBusinessProfileCreator";
import { BusinessProfileService } from "./businessProfileService";
import { DrizzleBusinessProfileRepository } from "./drizzleBusinessProfileRepository";

let cached: BusinessProfileService | null = null;

export function getBusinessProfileService(): BusinessProfileService {
  if (!cached) {
    cached = new BusinessProfileService(
      new DrizzleBusinessProfileRepository(),
      new AuditService(new DrizzleAuditEventRepository()),
      // Checkpoint review (2026-10-02): the atomic creator is mandatory — see
      // AtomicBusinessProfileCreator's own doc comment for why a two-step, non-transactional
      // insert(profile) then insert(membership) is not an acceptable substitute.
      new DrizzleAtomicBusinessProfileCreator(),
    );
  }
  return cached;
}
