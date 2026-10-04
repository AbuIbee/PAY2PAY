import { randomUUID } from "node:crypto";
import type { StaffRole } from "@/lib/staff/capabilities";
import type { LegacyInvitationRow, LegacyMembershipRow, LegacyRoleMigrationRepository } from "./legacyRoleMigration";

/**
 * Deliberately structural (duck-typed), NOT `import type { InMemoryBusinessStaffMemberRepository }
 * from "@/lib/staff/testFakes"` — `staff/testFakes.ts` needs to construct this class too (so every
 * legacy-role-seeded test membership gets a resolvable `role_id`, matching `StaffService`'s own
 * mutation-time behavior), and `organizations/testFakes.ts` already imports FROM `staff/testFakes.ts`,
 * so a value import in the other direction would be circular. Both
 * `InMemoryBusinessStaffMemberRepository`/`InMemoryStaffInvitationRepository` satisfy these shapes
 * structurally without either file needing to import the other's concrete class.
 */
interface MinimalStaffMemberStore {
  byId: Map<string, { businessProfileId: string; role: StaffRole; roleId: string | null }>;
}
interface MinimalInvitationStore {
  byId: Map<string, { businessProfileId: string; role: string; roleId: string | null }>;
}

/** Bridges `LegacyRoleMigrationRepository` onto a test's own staff/invitation in-memory stores, so a migration run is actually observable through the SAME fakes the rest of a test fixture already uses. */
export class BridgingLegacyRoleMigrationRepository implements LegacyRoleMigrationRepository {
  constructor(
    private readonly staffMembers: MinimalStaffMemberStore,
    private readonly invitations?: MinimalInvitationStore,
  ) {}

  async listOrganizationIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const m of this.staffMembers.byId.values()) ids.add(m.businessProfileId);
    if (this.invitations) for (const i of this.invitations.byId.values()) ids.add(i.businessProfileId);
    return [...ids];
  }

  async listMembershipsNeedingBackfill(organizationId: string): Promise<LegacyMembershipRow[]> {
    return [...this.staffMembers.byId.entries()]
      .filter(([, m]) => m.businessProfileId === organizationId)
      .map(([id, m]) => ({ id, organizationId: m.businessProfileId, role: m.role, roleId: m.roleId }));
  }

  async listInvitationsNeedingBackfill(organizationId: string): Promise<LegacyInvitationRow[]> {
    if (!this.invitations) return [];
    return [...this.invitations.byId.entries()]
      .filter(([, i]) => i.businessProfileId === organizationId)
      .map(([id, i]) => ({ id, organizationId: i.businessProfileId, role: i.role as StaffRole, roleId: i.roleId }));
  }

  async setMembershipRoleId(membershipId: string, roleId: string): Promise<void> {
    const member = this.staffMembers.byId.get(membershipId);
    if (member) member.roleId = roleId;
  }

  async setInvitationRoleId(invitationId: string, roleId: string): Promise<void> {
    if (!this.invitations) return;
    const invitation = this.invitations.byId.get(invitationId);
    if (invitation) invitation.roleId = roleId;
  }
}

/** Test-only in-memory double, mirroring the rest of this codebase's per-domain testFakes.ts pattern. */
export class InMemoryLegacyRoleMigrationRepository implements LegacyRoleMigrationRepository {
  memberships: LegacyMembershipRow[] = [];
  invitations: LegacyInvitationRow[] = [];

  seedMembership(organizationId: string, role: StaffRole): LegacyMembershipRow {
    const row: LegacyMembershipRow = { id: randomUUID(), organizationId, role, roleId: null };
    this.memberships.push(row);
    return row;
  }

  seedInvitation(organizationId: string, role: StaffRole): LegacyInvitationRow {
    const row: LegacyInvitationRow = { id: randomUUID(), organizationId, role, roleId: null };
    this.invitations.push(row);
    return row;
  }

  async listOrganizationIds(): Promise<string[]> {
    return [...new Set([...this.memberships.map((m) => m.organizationId), ...this.invitations.map((i) => i.organizationId)])];
  }

  async listMembershipsNeedingBackfill(organizationId: string): Promise<LegacyMembershipRow[]> {
    return this.memberships.filter((m) => m.organizationId === organizationId);
  }

  async listInvitationsNeedingBackfill(organizationId: string): Promise<LegacyInvitationRow[]> {
    return this.invitations.filter((i) => i.organizationId === organizationId);
  }

  async setMembershipRoleId(membershipId: string, roleId: string): Promise<void> {
    const row = this.memberships.find((m) => m.id === membershipId);
    if (row) row.roleId = roleId;
  }

  async setInvitationRoleId(invitationId: string, roleId: string): Promise<void> {
    const row = this.invitations.find((i) => i.id === invitationId);
    if (row) row.roleId = roleId;
  }
}
