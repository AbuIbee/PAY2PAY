import "server-only";
import { getDb, type Database } from "@/db/client";
import { businessProfile, businessStaffMember, organizationRole, organizationRolePermission } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import { ownerPermissionKeys } from "@/lib/organizations/defaultRoleTemplates";
import type { StaffRole } from "@/lib/staff/capabilities";
import type { BusinessStaffMemberRecord } from "@/lib/staff/staffService";
import type { BusinessProfileRecord } from "./businessProfileService";

type BusinessProfileRow = typeof businessProfile.$inferSelect;
type BusinessStaffMemberRow = typeof businessStaffMember.$inferSelect;

function toProfileRecord(row: BusinessProfileRow): BusinessProfileRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    legalBusinessName: row.legalBusinessName,
    displayName: row.displayName,
    entityType: row.entityType,
    businessAddress: row.businessAddress,
    country: row.country,
    state: row.state,
    status: row.status,
    currency: row.currency,
    createdAt: row.createdAt,
    dbaName: row.dbaName,
    industry: row.industry,
    formationJurisdiction: row.formationJurisdiction,
    businessEmail: row.businessEmail,
    website: row.website,
    representative: row.representativeFirstName
      ? {
          firstName: row.representativeFirstName,
          lastName: row.representativeLastName ?? "",
          title: row.representativeTitle ?? "",
          email: row.representativeEmail ?? "",
          phone: row.representativePhone ?? "",
          relationshipToBusiness: row.representativeRelationship ?? "",
        }
      : null,
    onboardingStep: row.onboardingStep,
  };
}

function toMembershipRecord(row: BusinessStaffMemberRow): BusinessStaffMemberRecord {
  return {
    id: row.id,
    businessProfileId: row.businessProfileId,
    userId: row.userId,
    role: row.role as StaffRole,
    customRoleId: row.customRoleId,
    roleId: row.roleId,
    isAuthorizedRepresentative: row.isAuthorizedRepresentative,
    removedAt: row.removedAt,
    createdAt: row.createdAt,
  };
}

export interface AtomicBusinessProfileCreatorInput {
  ownerUserId: string;
  legalBusinessName: string;
  displayName: string;
  entityType: string;
  businessAddress: unknown;
  country: string;
  state: string;
}

export interface AtomicBusinessProfileCreatorResult {
  profile: BusinessProfileRecord;
  ownerMembership: BusinessStaffMemberRecord;
}

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE" (owner-bootstrap atomicity
 * fix, checkpoint review 2026-10-02): the ONLY sanctioned way to create a real `business_profile`
 * ("Organization"). `BusinessProfileService.createBusinessProfile` must go through this, never
 * through `BusinessProfileRepository.insert` directly — that method stays on the repository
 * interface for read-path symmetry only (findById/listByOwner/updateStatus all live there too), and
 * must never be called on its own to create a production organization, since it has no way to also
 * create the OWNER membership.
 */
export interface AtomicBusinessProfileCreator {
  createAtomically(input: AtomicBusinessProfileCreatorInput): Promise<AtomicBusinessProfileCreatorResult>;
}

/**
 * Mirrors `DrizzleAtomicPayoutConfirmer`'s established "single, hand-written multi-table
 * transaction, writing directly against raw Drizzle table objects so every statement shares the
 * same `tx`" pattern (src/lib/payouts/atomicPayoutConfirmer.ts), for the identical reason documented
 * there: `DrizzleBusinessProfileRepository` and `DrizzleBusinessStaffMemberRepository` each open
 * their own `getDb()` connection and perform independently-committed statements. The prior
 * implementation called `businessProfileRepo.insert()` and then, separately,
 * `staffMemberRepo.insert()` — two uncoordinated writes. A crash, validation failure, or dropped
 * connection between them was reachable and would leave a `business_profile` permanently without
 * its OWNER `business_staff_member` row: an organization whose own creator could never pass
 * `StaffService.requireActiveStaff` for the organization they just created.
 *
 * Both inserts now happen inside ONE `db.transaction`: either both rows exist, or neither does.
 */
export class DrizzleAtomicBusinessProfileCreator implements AtomicBusinessProfileCreator {
  constructor(private readonly db: Database = getDb()) {}

  async createAtomically(input: AtomicBusinessProfileCreatorInput): Promise<AtomicBusinessProfileCreatorResult> {
    return this.db.transaction(async (tx) => {
      const [profileRow] = await tx
        .insert(businessProfile)
        .values({ ...input, businessAddress: input.businessAddress as object | null })
        .returning();
      if (!profileRow) {
        throw new ConfigurationError("business_profile insert returned no row during atomic organization creation");
      }

      // "Final RBAC Authorization Cutover", Step 5/6: this organization cannot already have an Owner
      // organization_role (it didn't exist a moment ago), so this is always a first-time creation —
      // never a lookup-then-maybe-create race. Inline (rather than
      // `LegacyRoleMigrationService.resolveOrCreateEquivalentRole`) so it shares this SAME transaction
      // with the profile/membership inserts above/below: the OWNER membership must never be written
      // with a null role_id, even transiently between statements (the business_staff_member_active_
      // role_id_required CHECK constraint would reject an insert-then-update two-step for exactly that
      // reason).
      const [ownerRoleRow] = await tx
        .insert(organizationRole)
        .values({ organizationId: profileRow.id, displayName: "Owner", description: null, isOwnerRole: true, isProtected: true, sortOrder: 0 })
        .returning();
      if (!ownerRoleRow) {
        throw new ConfigurationError("organization_role insert returned no row during atomic organization creation");
      }
      const ownerPermissionRows = ownerPermissionKeys().map((permissionKey) => ({ roleId: ownerRoleRow.id, permissionKey, scope: "organization" as const }));
      if (ownerPermissionRows.length > 0) {
        await tx.insert(organizationRolePermission).values(ownerPermissionRows);
      }

      const [membershipRow] = await tx
        .insert(businessStaffMember)
        .values({
          businessProfileId: profileRow.id,
          userId: input.ownerUserId,
          role: "OWNER",
          customRoleId: null,
          roleId: ownerRoleRow.id,
          isAuthorizedRepresentative: true,
        })
        .returning();
      if (!membershipRow) {
        throw new ConfigurationError("business_staff_member insert returned no row during atomic organization creation");
      }

      return { profile: toProfileRecord(profileRow), ownerMembership: toMembershipRecord(membershipRow) };
    });
  }
}
