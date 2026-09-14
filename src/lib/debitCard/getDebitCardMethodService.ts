import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { DebitCardMethodService } from "./debitCardMethodService";
import { DrizzleDebitCardMethodRepository } from "./drizzleDebitCardMethodRepository";

let cached: DebitCardMethodService | null = null;

export function getDebitCardMethodService(): DebitCardMethodService {
  if (!cached) {
    cached = new DebitCardMethodService({
      cards: new DrizzleDebitCardMethodRepository(),
      profileOwners: new DrizzleProfileOwnerReader(),
      // R08 B1 (CARD-1): narrow read-only dependency — never AgreementService, never a second DB client.
      agreements: new DrizzleAgreementRepository(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
