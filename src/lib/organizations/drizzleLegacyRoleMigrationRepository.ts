import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessProfile, businessStaffInvitation, businessStaffMember } from "@/db/schema";
import type { StaffRole } from "@/lib/staff/capabilities";
import type { LegacyInvitationRow, LegacyMembershipRow, LegacyRoleMigrationRepository } from "./legacyRoleMigration";

export class DrizzleLegacyRoleMigrationRepository implements LegacyRoleMigrationRepository {
  async listOrganizationIds(): Promise<string[]> {
    const db = getDb();
    const rows = await db.select({ id: businessProfile.id }).from(businessProfile);
    return rows.map((r) => r.id);
  }

  async listMembershipsNeedingBackfill(organizationId: string): Promise<LegacyMembershipRow[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessStaffMember)
      .where(eq(businessStaffMember.businessProfileId, organizationId));
    return rows.map((r) => ({ id: r.id, organizationId: r.businessProfileId, role: r.role as StaffRole, roleId: r.roleId }));
  }

  async listInvitationsNeedingBackfill(organizationId: string): Promise<LegacyInvitationRow[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessStaffInvitation)
      .where(eq(businessStaffInvitation.businessProfileId, organizationId));
    return rows.map((r) => ({ id: r.id, organizationId: r.businessProfileId, role: r.role as StaffRole, roleId: r.roleId }));
  }

  async setMembershipRoleId(membershipId: string, roleId: string): Promise<void> {
    const db = getDb();
    await db.update(businessStaffMember).set({ roleId }).where(eq(businessStaffMember.id, membershipId));
  }

  async setInvitationRoleId(invitationId: string, roleId: string): Promise<void> {
    const db = getDb();
    await db.update(businessStaffInvitation).set({ roleId }).where(eq(businessStaffInvitation.id, invitationId));
  }
}
