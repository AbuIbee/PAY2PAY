import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { DebitCardMethodService } from "./debitCardMethodService";
import { DrizzleDebitCardMethodRepository } from "./drizzleDebitCardMethodRepository";

let cached: DebitCardMethodService | null = null;

export function getDebitCardMethodService(): DebitCardMethodService {
  if (!cached) {
    cached = new DebitCardMethodService({
      cards: new DrizzleDebitCardMethodRepository(),
      profileOwners: new DrizzleProfileOwnerReader(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
