/**
 * Sprint 4 (docs/sprints/SPRINT_04_BusinessStaff_Permissions.md): "Do not use
 * role names alone as authorization. Implement explicit permission
 * capabilities." Every authorization check in this module goes through
 * `hasCapability`/`requireCapability` (staffService.ts) — never a bare
 * `role === "manager"` comparison — so a role rename or a custom role never
 * silently bypasses a check written against the wrong thing.
 */
/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE" (2026-10-02): extended with
 * the Business Workspace's own resource-type capabilities (customers, balances/obligations,
 * documents, audit history, reconciliation, integrations, organization settings, subscription
 * administration) — the original Sprint 4 list below (`create_agreement` through
 * `approve_high_value_action`) is unchanged and still governs the agreement/approval-policy
 * workflows that already use it.
 */
export const CAPABILITIES = [
  "create_agreement",
  "send_invitation",
  "approve_agreement",
  "propose_amendment",
  "approve_hardship",
  "approve_partial_payment",
  "approve_settlement",
  "forgive_principal",
  "export_records",
  "view_reports",
  "manage_staff",
  "change_payout_configuration",
  "approve_high_value_action",
  "manage_customers",
  "manage_balances",
  "manage_documents",
  "view_audit_history",
  "manage_reconciliation",
  "manage_integrations",
  "manage_organization_settings",
  "manage_subscription",
  // "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 8 (2026-10-02):
  // deliberately NOT a reuse of the pre-existing `create_agreement` capability above. That
  // capability governs a completely different, already-established question inside
  // AgreementService.createDraft itself: "is this user authorized to act for the creditor/debtor
  // PARTY" (personal agreements, B2C, and the existing business-staff-as-party B2B flow alike) —
  // it already grants AR_AGENT today, and changing that would be an unreviewed behavior change to
  // existing, heavily-tested authorization. `manage_agreements` is the new, separate question Phase
  // 8 introduces: "may this staff member tag an agreement as belonging to this ORGANIZATION
  // WORKSPACE at all" (see src/lib/organizations/agreementWorkspaceService.ts). Conservative
  // default: AR_AGENT does NOT get it this phase (see DEFAULT_ROLE_CAPABILITIES below).
  "manage_agreements",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE" (2026-10-02): the five
 * canonical organization roles, replacing the prior `owner | manager | receivables_staff |
 * accountant_viewer | custom` vocabulary. "custom" is deliberately not carried forward (see
 * organizationRoleEnum's own doc comment in src/db/schema/enums.ts) — arbitrary custom roles are
 * explicitly deferred for this phase.
 */
export type StaffRole = "OWNER" | "FINANCE_ADMIN" | "AR_MANAGER" | "AR_AGENT" | "VIEWER";

/**
 * "OWNER" is intentionally absent here: OwnerAdmin always has every
 * capability (see hasCapability in staffService.ts), rather than needing to
 * be kept in sync with this list as new capabilities are added. VIEWER is
 * present with an explicitly empty set — read-only access is granted by plain
 * active membership (no capability needed to view), never by any entry here.
 *
 * Mapped directly from the architecture's own permission matrix:
 *   FINANCE_ADMIN — "all financial operations... staff management except ownership-transfer
 *     functions" (ownership-transfer itself is blocked by a separate owner-only check in
 *     staffService.ts, not by withholding manage_staff); integrations/org-settings/subscription
 *     administration are deliberately NOT granted (OWNER-only, or entitlement-gated — see
 *     src/lib/organizations/entitlements.ts).
 *   AR_MANAGER / AR_AGENT — "manage customers/balances/agreements... no ownership; no subscription
 *     changes; no destructive organization administration." This phase does not yet model a
 *     per-record "assigned to me" scope, so AR_MANAGER and AR_AGENT currently share one capability
 *     set; the architecture's "permitted customers/balances" distinction for AR_AGENT is a known
 *     limitation (documented in the final acceptance report), not silently dropped.
 *   VIEWER — no mutating capability at all.
 */
export const DEFAULT_ROLE_CAPABILITIES: Record<Exclude<StaffRole, "OWNER">, readonly Capability[]> = {
  FINANCE_ADMIN: [
    "create_agreement",
    "send_invitation",
    "approve_agreement",
    "propose_amendment",
    "approve_hardship",
    "approve_partial_payment",
    "approve_settlement",
    "forgive_principal",
    "export_records",
    "view_reports",
    "manage_staff",
    "change_payout_configuration",
    "approve_high_value_action",
    "manage_customers",
    "manage_balances",
    "manage_documents",
    "view_audit_history",
    "manage_reconciliation",
    "manage_agreements",
  ],
  // Phase 8: AR_MANAGER gets manage_agreements (organization-workspace agreement creation);
  // AR_AGENT deliberately does not, this phase — a conservative default, not a permanent ceiling
  // (see manage_agreements's own doc comment in the CAPABILITIES list above).
  AR_MANAGER: ["create_agreement", "propose_amendment", "manage_customers", "manage_balances", "manage_documents", "view_reports", "manage_agreements"],
  AR_AGENT: ["create_agreement", "propose_amendment", "manage_customers", "manage_balances", "manage_documents", "view_reports"],
  VIEWER: [],
};

/**
 * Capabilities that, per this sprint's text ("settlement approval limits,
 * balance-adjustment limits, two-person approval configuration,
 * owner-required thresholds"), are gated a second time by
 * ApprovalService/business_approval_policy rather than by plain
 * capability-possession alone. Also drives StaffService.removeStaff's
 * step-up requirement: removing a staff member who holds one of these is a
 * high-risk change, not routine roster maintenance.
 */
export const HIGH_RISK_CAPABILITIES: readonly Capability[] = [
  "approve_settlement",
  "forgive_principal",
  "manage_staff",
  "change_payout_configuration",
  "approve_high_value_action",
];
