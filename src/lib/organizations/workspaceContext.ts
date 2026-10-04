import "server-only";
import type { BusinessProfileRepository } from "@/lib/profiles/businessProfileService";
import type { StaffRole } from "@/lib/staff/capabilities";
import type { BusinessStaffMemberRepository } from "@/lib/staff/staffService";
import type { OrganizationAuthorizationService } from "./organizationAuthorizationService";

export type WorkspaceSelector = { kind: "personal" } | { kind: "organization"; organizationId: string };

export type WorkspaceContext =
  | { kind: "personal" }
  | { kind: "organization"; organizationId: string; membershipRole: StaffRole };

export interface WorkspaceListItem {
  organizationId: string;
  displayName: string;
  membershipRole: StaffRole;
}

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 2 (2026-10-02),
 * Phase 6: the authenticated user never changes when switching workspace — this resolves which
 * CONTEXT (personal vs. a specific organization, with the caller's own role in it) is currently
 * validated for them, re-verified from the database on every call. A client-supplied
 * organizationId is a request/preference only, never authorization: if the membership it names is
 * missing or has been removed, the organization context is rejected and this falls back to
 * personal — it never throws a distinguishing error and never partially trusts the request.
 *
 * Deliberately NOT the same class as ProfileAccessService (src/lib/profiles/profileAccessService.ts)
 * — that pre-existing service's business-selector branch only ever recognized the business's
 * OWNER (`business.ownerUserId !== userId` is its entire check), which is exactly wrong for this
 * architecture: a VIEWER or FINANCE_ADMIN staff member who is not the owner must still be able to
 * select that organization's workspace. Rather than weaken ProfileAccessService's existing
 * owner-only semantics (unknown what else currently depends on that exact behavior) or make it
 * staff-aware, this is a new, narrower resolver built directly on OrganizationAuthorizationService's
 * membership check, used specifically for the organization-workspace switcher introduced in this
 * branch.
 */
export class WorkspaceContextService {
  constructor(
    private readonly orgAuth: OrganizationAuthorizationService,
    /**
     * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 7/8: optional — only `listWorkspacesForUser`
     * (the workspace selector's own listing source) needs these; `resolveWorkspaceContext` (the
     * pre-existing, already-relied-upon method) uses neither, so every existing construction site
     * that omits them is unaffected.
     */
    private readonly staffMembers?: BusinessStaffMemberRepository,
    private readonly businessProfiles?: BusinessProfileRepository,
  ) {}

  async resolveWorkspaceContext(userId: string, selector: WorkspaceSelector): Promise<WorkspaceContext> {
    if (selector.kind === "personal") return { kind: "personal" };

    const membership = await this.orgAuth.resolveOrganizationMembership(userId, selector.organizationId);
    if (!membership) return { kind: "personal" };

    return { kind: "organization", organizationId: selector.organizationId, membershipRole: membership.role };
  }

  /**
   * Section 7/8: "Only organizations for which the authenticated user has valid membership may
   * appear." Re-resolves each candidate membership through the SAME `resolveOrganizationMembership`
   * path `resolveWorkspaceContext` uses (organization must still exist and be "active", membership
   * must still be active/non-removed) — never trusts a bare `business_staff_member` row alone, since
   * the organization itself could have been disabled since that row was written.
   */
  async listWorkspacesForUser(userId: string): Promise<WorkspaceListItem[]> {
    if (!this.staffMembers || !this.businessProfiles) return [];
    const memberships = await this.staffMembers.listActiveByUser(userId);
    const items: WorkspaceListItem[] = [];
    for (const membership of memberships) {
      const revalidated = await this.orgAuth.resolveOrganizationMembership(userId, membership.businessProfileId);
      if (!revalidated) continue;
      const profile = await this.businessProfiles.findById(membership.businessProfileId);
      if (!profile) continue;
      items.push({ organizationId: profile.id, displayName: profile.displayName, membershipRole: revalidated.role });
    }
    return items;
  }
}
