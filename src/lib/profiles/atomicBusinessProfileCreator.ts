import "server-only";
import { getDb, type Database } from "@/db/client";
import { businessProfile, businessStaffMember } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
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
  };
}

function toMembershipRecord(row: BusinessStaffMemberRow): BusinessStaffMemberRecord {
  return {
    id: row.id,
    businessProfileId: row.businessProfileId,
    userId: row.userId,
    role: row.role as StaffRole,
    customRoleId: row.customRoleId,
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

      const [membershipRow] = await tx
        .insert(businessStaffMember)
        .values({
          businessProfileId: profileRow.id,
          userId: input.ownerUserId,
          role: "OWNER",
          customRoleId: null,
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
