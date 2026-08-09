/**
 * Sprint 4 (docs/sprints/SPRINT_04_BusinessStaff_Permissions.md): "Do not use
 * role names alone as authorization. Implement explicit permission
 * capabilities." Every authorization check in this module goes through
 * `hasCapability`/`requireCapability` (staffService.ts) — never a bare
 * `role === "manager"` comparison — so a role rename or a custom role never
 * silently bypasses a check written against the wrong thing.
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
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

export type StaffRole = "owner" | "manager" | "receivables_staff" | "accountant_viewer" | "custom";

/**
 * "owner" is intentionally absent here: OwnerAdmin always has every
 * capability (see hasCapability in staffService.ts), rather than needing to
 * be kept in sync with this list as new capabilities are added. "custom"
 * is also absent — a custom role's capabilities come entirely from its own
 * custom_role.permissions row, never from a default set.
 */
export const DEFAULT_ROLE_CAPABILITIES: Record<Exclude<StaffRole, "owner" | "custom">, readonly Capability[]> = {
  manager: [
    "create_agreement",
    "send_invitation",
    "approve_agreement",
    "propose_amendment",
    "approve_hardship",
    "approve_partial_payment",
    "export_records",
    "view_reports",
  ],
  receivables_staff: ["create_agreement", "send_invitation", "propose_amendment", "view_reports"],
  accountant_viewer: ["view_reports", "export_records"],
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
