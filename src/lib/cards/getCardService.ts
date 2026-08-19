import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getStaffService } from "@/lib/staff/getStaffService";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import { CardService } from "./cardService";
import { DrizzleIssuedCardRepository } from "./drizzleIssuedCardRepository";
import { getCardIssuingProvider } from "./getCardIssuingProvider";

let cached: CardService | null = null;

export function getCardService(): CardService {
  if (!cached) {
    cached = new CardService({
      cards: new DrizzleIssuedCardRepository(),
      provider: getCardIssuingProvider(),
      verification: getVerificationService(),
      profileOwners: new DrizzleProfileOwnerReader(),
      staffService: getStaffService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
