import "server-only";
import type { Capability, StaffRole } from "@/lib/staff/capabilities";
import { DEFAULT_ROLE_CAPABILITIES } from "@/lib/staff/capabilities";
import { ownerPermissionKeys } from "./defaultRoleTemplates";
import type { OrganizationRoleRepository } from "./organizationRoleRepository";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 12: translates the OLD, hardcoded
 * `organizationRoleEnum` vocabulary (capabilities.ts's own `Capability` keys) into the NEW stable
 * permission catalog (permissionCatalog.ts) — the two vocabularies do not line up 1:1 (the old
 * model has no separate "balances"/"customers"/"documents" resource granularity; the new model has
 * no single "manage_staff"-shaped umbrella). This map is a best-effort, CONSERVATIVE conceptual
 * equivalence, not a certainty — flagged here explicitly for business/product review before this
 * migration is ever run against real legacy data. It is exercised only by this backfill, never by
 * any live authorization decision (the enum `role` column remains the sole authorization source
 * until a separate, later cutover — see organizationRoles.ts's own doc comment).
 */
export const LEGACY_CAPABILITY_TO_PERMISSION_KEYS: Readonly<Record<Capability, readonly string[]>> = {
  // "PAID2YOU PLATFORM EXPANSION", Final RBAC Authorization Cutover, Step 9: `create_agreement` is a
  // PARTY-level legacy capability (AgreementService.authorizeParty — "may this actor act for the
  // creditor/debtor party") and intentionally has NO organization-level catalog equivalent here.
  // Collapsing it onto `agreements.create` was the exact bug this cutover fixes: AR_AGENT held
  // `create_agreement` but never `manage_agreements`, and Phase 8 deliberately denies AR_AGENT
  // organization agreement creation (agreementWorkspaceService.test.ts) — mapping `create_agreement`
  // to any `agreements.*` key here would silently re-grant AR_AGENT that denied access. Likewise
  // `propose_amendment`/`approve_agreement`/`approve_hardship`/`approve_settlement` are PARTY-level
  // legacy capabilities exercised by AgreementService's own internal authorization, never by
  // `AgreementWorkspaceService`'s organization-level gate — they carry no organization-level
  // `agreements.*` equivalent either. `manage_agreements` alone is, and always was, the one legacy
  // capability `AgreementWorkspaceService.createDraftForWorkspace` ever checked.
  create_agreement: [],
  send_invitation: ["members.invite"],
  approve_agreement: [],
  propose_amendment: [],
  approve_hardship: [],
  approve_partial_payment: ["payments.approve"],
  approve_settlement: [],
  forgive_principal: ["balances.resolve"],
  export_records: ["reports.export"],
  view_reports: ["reports.view"],
  manage_staff: ["members.view", "members.invite", "members.edit", "members.remove", "roles.view", "roles.assign"],
  change_payout_configuration: ["payments.prepare"],
  approve_high_value_action: ["payments.approve"],
  manage_customers: ["customers.view", "customers.create", "customers.edit", "customers.archive", "customers.export"],
  manage_balances: ["balances.view", "balances.create", "balances.edit", "balances.resolve", "balances.export"],
  manage_documents: ["documents.view", "documents.upload", "documents.edit_metadata", "documents.archive", "documents.export"],
  view_audit_history: ["audit.view"],
  manage_reconciliation: ["reconciliation.view", "reconciliation.match", "reconciliation.resolve", "reconciliation.export"],
  manage_integrations: ["integrations.view", "integrations.connect", "integrations.configure", "integrations.disconnect"],
  manage_organization_settings: ["organization.view", "organization.edit"],
  manage_subscription: ["subscription.view", "subscription.manage", "subscription.payment_method.manage", "subscription.invoices.view", "subscription.invoices.export"],
  // The sole legacy source of organization-level agreement authority (see this map's own doc comment
  // above) — matches exactly what the new default "Manager" template grants (defaultRoleTemplates.ts),
  // minus `agreements.request_changes`, which that template also does not grant.
  manage_agreements: ["agreements.create", "agreements.edit", "agreements.send", "agreements.cancel", "agreements.export"],
};

const LEGACY_ROLE_DISPLAY_NAME: Readonly<Record<StaffRole, string>> = {
  OWNER: "Owner",
  FINANCE_ADMIN: "Finance Administrator",
  AR_MANAGER: "AR Manager",
  AR_AGENT: "AR Agent",
  VIEWER: "Viewer",
};

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Section 4: the old model's
 * read access was NOT capability-gated for ordinary resources at all — `OrganizationAuthorizationService.
 * canReadOrganizationResource` granted every ordinary (non-`SENSITIVE_ORGANIZATION_RESOURCE_CAPABILITY`)
 * resource to ANY active membership, VIEWER included, independent of `StaffService.hasCapability`. Only
 * the five sensitive resources (audit history, reconciliation, integrations, organization settings,
 * subscription) required a specific capability, and those are already correctly represented by the
 * capability-driven entries in `LEGACY_CAPABILITY_TO_PERMISSION_KEYS` above. Before the runtime cutover
 * this distinction didn't matter — these rows were never consulted for authorization. Now that they are
 * the actual runtime source, VIEWER's literal `DEFAULT_ROLE_CAPABILITIES` entry (`[]`) alone would
 * translate to ZERO permissions, which would regress a VIEWER's real effective access rather than
 * preserve it. These ambient `.view` keys are granted to every legacy role (including VIEWER) to
 * reproduce the old "any active member may read an ordinary resource" rule exactly.
 */
const AMBIENT_VIEW_KEYS_FOR_ANY_ACTIVE_MEMBER: readonly string[] = [
  "dashboard.view",
  "balances.view",
  "customers.view",
  "agreements.view",
  "payments.view",
  "members.view",
  "reports.view",
  "documents.view",
];

export function translatedPermissionKeysForLegacyRole(role: StaffRole): readonly string[] {
  if (role === "OWNER") return ownerPermissionKeys();
  const capabilities = DEFAULT_ROLE_CAPABILITIES[role];
  const keys = new Set<string>(AMBIENT_VIEW_KEYS_FOR_ANY_ACTIVE_MEMBER);
  for (const capability of capabilities) {
    for (const key of LEGACY_CAPABILITY_TO_PERMISSION_KEYS[capability]) keys.add(key);
  }
  return [...keys];
}

export interface LegacyMembershipRow {
  id: string;
  organizationId: string;
  role: StaffRole;
  roleId: string | null;
}

export interface LegacyInvitationRow {
  id: string;
  organizationId: string;
  role: StaffRole;
  roleId: string | null;
}

/** Minimal, dedicated read/write surface this one-time backfill needs — deliberately NOT the existing StaffService repository contracts, which this migration must not ripple into. */
export interface LegacyRoleMigrationRepository {
  listOrganizationIds(): Promise<string[]>;
  listMembershipsNeedingBackfill(organizationId: string): Promise<LegacyMembershipRow[]>;
  listInvitationsNeedingBackfill(organizationId: string): Promise<LegacyInvitationRow[]>;
  setMembershipRoleId(membershipId: string, roleId: string): Promise<void>;
  setInvitationRoleId(invitationId: string, roleId: string): Promise<void>;
}

export interface LegacyRoleMigrationResult {
  organizationsProcessed: number;
  membershipsBackfilled: number;
  invitationsBackfilled: number;
}

/**
 * "Final RBAC Authorization Cutover", Step 5/6: the narrow surface `StaffService` depends on, so it
 * need not import the full `LegacyRoleMigrationService`/`OrganizationRoleRepository` dependency graph
 * — `LegacyRoleMigrationService` satisfies this structurally.
 */
export interface EquivalentRoleResolver {
  resolveOrCreateEquivalentRole(organizationId: string, legacyRole: StaffRole): Promise<string>;
}

/**
 * Section 12's own required proof points: preserves existing members, preserves pending
 * invitations, preserves effective permissions (via the translation table above), preserves Owner,
 * enforces FK integrity (every created organization_role row belongs to the correct organization
 * before any membership/invitation is pointed at it), and prevents orphan roles (a role is only ever
 * created alongside the backfill that immediately uses it — never speculatively). Fully idempotent:
 * re-running against an organization that already has its 5 legacy-equivalent roles is a no-op for
 * role creation, and only backfills rows whose `roleId` is still null.
 */
export class LegacyRoleMigrationService {
  constructor(
    private readonly legacy: LegacyRoleMigrationRepository,
    private readonly roles: OrganizationRoleRepository,
  ) {}

  /**
   * "Final RBAC Authorization Cutover", Step 5/6: the single place that resolves (creating if
   * necessary) the `organization_role` row equivalent to a legacy `StaffRole` for one organization —
   * idempotent (`findRoleByOrganizationAndName` short-circuits once the role already exists). Used by
   * both the bulk `migrateOrganization` backfill below AND, directly, by `StaffService` at
   * invite/accept/role-change mutation time, so that no NEW or CHANGED legacy-role membership can ever
   * be written with a null `role_id` in the first place — the bulk backfill then only has pre-existing
   * historical data left to repair.
   */
  async resolveOrCreateEquivalentRole(organizationId: string, legacyRole: StaffRole): Promise<string> {
    const displayName = LEGACY_ROLE_DISPLAY_NAME[legacyRole];
    let role = await this.roles.findRoleByOrganizationAndName(organizationId, displayName);
    if (!role) {
      role = await this.roles.insertRole({
        organizationId,
        displayName,
        description: `Migrated from the legacy "${legacyRole}" role — preserves its exact prior effective permissions.`,
        isOwnerRole: legacyRole === "OWNER",
        isProtected: legacyRole === "OWNER",
        sortOrder: legacyRole === "OWNER" ? 0 : 50,
      });
      for (const permissionKey of translatedPermissionKeysForLegacyRole(legacyRole)) {
        await this.roles.insertPermission({ roleId: role.id, permissionKey, scope: "organization" });
      }
    }
    return role.id;
  }

  async migrateOrganization(organizationId: string): Promise<LegacyRoleMigrationResult> {
    const memberships = await this.legacy.listMembershipsNeedingBackfill(organizationId);
    const invitations = await this.legacy.listInvitationsNeedingBackfill(organizationId);

    const rolesNeeded = new Set<StaffRole>([...memberships.map((m) => m.role), ...invitations.map((i) => i.role)]);
    const roleIdByLegacyRole = new Map<StaffRole, string>();

    for (const legacyRole of rolesNeeded) {
      roleIdByLegacyRole.set(legacyRole, await this.resolveOrCreateEquivalentRole(organizationId, legacyRole));
    }

    let membershipsBackfilled = 0;
    for (const membership of memberships) {
      if (membership.roleId) continue;
      const roleId = roleIdByLegacyRole.get(membership.role);
      if (!roleId) continue;
      await this.legacy.setMembershipRoleId(membership.id, roleId);
      membershipsBackfilled += 1;
    }

    let invitationsBackfilled = 0;
    for (const invitation of invitations) {
      if (invitation.roleId) continue;
      const roleId = roleIdByLegacyRole.get(invitation.role);
      if (!roleId) continue;
      await this.legacy.setInvitationRoleId(invitation.id, roleId);
      invitationsBackfilled += 1;
    }

    return { organizationsProcessed: 1, membershipsBackfilled, invitationsBackfilled };
  }

  async migrateAllOrganizations(): Promise<LegacyRoleMigrationResult> {
    const organizationIds = await this.legacy.listOrganizationIds();
    const total: LegacyRoleMigrationResult = { organizationsProcessed: 0, membershipsBackfilled: 0, invitationsBackfilled: 0 };
    for (const organizationId of organizationIds) {
      const result = await this.migrateOrganization(organizationId);
      total.organizationsProcessed += 1;
      total.membershipsBackfilled += result.membershipsBackfilled;
      total.invitationsBackfilled += result.invitationsBackfilled;
    }
    return total;
  }
}
