import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getNotificationService } from "@/lib/notify/getNotificationService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { getStaffService } from "@/lib/staff/getStaffService";
import type { AgreementConnectionEstablisher, AgreementIdentitySnapshotter } from "./agreementService";
import { AgreementService } from "./agreementService";
import { DrizzleAgreementPartyRepository } from "./drizzleAgreementPartyRepository";
import { DrizzleAgreementRepository } from "./drizzleAgreementRepository";
import { DrizzleAgreementVersionRepository } from "./drizzleAgreementVersionRepository";
import { DrizzleInstallmentScheduleItemRepository } from "./drizzleInstallmentScheduleItemRepository";
import { DrizzleSigningApplicationRepository } from "./drizzleSigningApplicationRepository";
import { getAgreementPartyNameReader } from "./getAgreementPartyNameReader";

let cached: AgreementService | null = null;

/**
 * Decision 3/7: RelationshipService and AgreementIdentitySnapshotService both depend BACK on
 * AgreementService (to read agreement/party data), so calling their own `get*()` factories eagerly
 * here — during AgreementService's own construction — would recurse infinitely before either
 * singleton is cached. These two thin wrappers defer that resolution to first *call*, not
 * construction, breaking the cycle; by the time `establishAgreementRelationship`/`freezeSnapshot` is
 * actually invoked (well after module load), both singletons already exist.
 */
const connectionEstablisher: AgreementConnectionEstablisher = {
  async establishAgreementRelationship(input) {
    const { getRelationshipService } = await import("@/lib/relationships/getRelationshipService");
    return getRelationshipService().establishAgreementRelationship(input);
  },
  async proposeAgreementRelationship(input) {
    const { getRelationshipService } = await import("@/lib/relationships/getRelationshipService");
    return getRelationshipService().proposeAgreementRelationship(input);
  },
  async confirmAgreementRelationship(input) {
    const { getRelationshipService } = await import("@/lib/relationships/getRelationshipService");
    return getRelationshipService().confirmAgreementRelationship(input);
  },
};

const identitySnapshotter: AgreementIdentitySnapshotter = {
  async freezeSnapshot(input) {
    const { getAgreementIdentitySnapshotService } = await import("./getAgreementIdentitySnapshotService");
    return getAgreementIdentitySnapshotService().freezeSnapshot(input);
  },
};

/** Lazily creates (and memoizes) the production AgreementService. Mirrors getAuthService.ts's pattern. */
export function getAgreementService(): AgreementService {
  if (!cached) {
    cached = new AgreementService({
      agreements: new DrizzleAgreementRepository(),
      versions: new DrizzleAgreementVersionRepository(),
      parties: new DrizzleAgreementPartyRepository(),
      scheduleItems: new DrizzleInstallmentScheduleItemRepository(),
      profileOwners: new DrizzleProfileOwnerReader(),
      staffService: getStaffService(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
      signing: new DrizzleSigningApplicationRepository(),
      notifications: getNotificationService(),
      connectionEstablisher,
      identitySnapshotter,
      partyNames: getAgreementPartyNameReader(),
    });
  }
  return cached;
}
