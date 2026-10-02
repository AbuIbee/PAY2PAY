import "server-only";
import type { BusinessProfileRepository } from "@/lib/profiles/businessProfileService";
import type { Capability } from "@/lib/staff/capabilities";
import type { BusinessStaffMemberRecord, BusinessStaffMemberRepository, StaffService } from "@/lib/staff/staffService";

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 2 (2026-10-02),
 * Phases 3-4: the single centralized server-side authorization boundary for every
 * organization-owned resource. No route/component may compare a role string directly — every
 * authorization decision about an organization goes through one of this class's three methods.
 *
 * A browser-supplied organizationId is NEVER trusted on its own: every method here re-resolves
 * the caller's actual active membership from the database before answering, and fails closed
 * (false/null) on any missing, removed, or cross-tenant membership — never throws a distinguishing
 * error that would let a caller probe which organizations exist (same not-found/forbidden shape for
 * "no such organization" and "not a member of this organization").
 */
export const SENSITIVE_ORGANIZATION_RESOURCE_CAPABILITY = {
  audit_history: "view_audit_history",
  reconciliation: "manage_reconciliation",
  integrations: "manage_integrations",
  subscription: "manage_subscription",
  // Not named in the order's "sensitive reads" list verbatim, but organization_settings is the
  // same class of administrative/configuration surface as integrations/subscription — gating it
  // behind the capability that already exists specifically to manage it (manage_organization_settings)
  // rather than leaving it readable by plain membership.
  organization_settings: "manage_organization_settings",
} as const satisfies Partial<Record<OrganizationResourceType, Capability>>;

export type OrganizationResourceType =
  | "dashboard"
  | "outstanding_balances"
  | "customers"
  | "agreements"
  | "payments"
  | "employees"
  | "reports"
  | "reconciliation"
  | "documents"
  | "audit_history"
  | "integrations"
  | "organization_settings"
  | "subscription";

export class OrganizationAuthorizationService {
  constructor(
    private readonly businessProfiles: BusinessProfileRepository,
    private readonly staffMembers: BusinessStaffMemberRepository,
    private readonly staffService: StaffService,
  ) {}

  /**
   * The one place "does this user have an active membership in this organization" is answered.
   * Returns null (never throws) for: organization does not exist, organization is not active
   * (disabled/deleted), or the user has no active (non-removed) business_staff_member row there —
   * every caller treats all three identically, by design (see this class's own doc comment).
   */
  async resolveOrganizationMembership(userId: string, organizationId: string): Promise<BusinessStaffMemberRecord | null> {
    const org = await this.businessProfiles.findById(organizationId);
    if (!org || org.status !== "active") return null;
    return this.staffMembers.findActiveByBusinessAndUser(organizationId, userId);
  }

  /** WHO may perform this action — resolves membership, then the existing StaffService capability seam. Never a bare role-string comparison. */
  async can(userId: string, organizationId: string, capability: Capability): Promise<boolean> {
    const membership = await this.resolveOrganizationMembership(userId, organizationId);
    if (!membership) return false;
    return this.staffService.hasCapability(membership, capability);
  }

  /**
   * Phase 3: distinguishes baseline organization-membership read access from privileged/mutation
   * capabilities. Any active membership (VIEWER included) may read an ordinary organization
   * resource. A resource listed in SENSITIVE_ORGANIZATION_RESOURCE_CAPABILITY additionally requires
   * the specific capability named there — VIEWER's empty capability set means VIEWER is correctly
   * denied those, without VIEWER ever being granted a mutation capability to achieve that denial.
   */
  async canReadOrganizationResource(userId: string, organizationId: string, resourceType: OrganizationResourceType): Promise<boolean> {
    const membership = await this.resolveOrganizationMembership(userId, organizationId);
    if (!membership) return false;
    const requiredCapability = (SENSITIVE_ORGANIZATION_RESOURCE_CAPABILITY as Partial<Record<OrganizationResourceType, Capability>>)[resourceType];
    if (!requiredCapability) return true;
    return this.staffService.hasCapability(membership, requiredCapability);
  }
}
