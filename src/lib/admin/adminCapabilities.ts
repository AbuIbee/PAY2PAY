/**
 * Sprint 18 (docs/sprints/SPRINT_18_AdminSupport_Appeals.md): the fixed internal-admin capability
 * vocabulary — mirrors Sprint 4's `src/lib/staff/capabilities.ts` shape exactly ("Do not use role
 * names alone as authorization. Implement explicit permission capabilities.", applied here to
 * platform-level internal staff rather than per-business staff).
 *
 * `suspend_account` is included for parity with the master spec's own §29 admin-action list but is
 * NOT actively enforced anywhere in this pass — Sprint 6A's `AdminService.suspendUser`/`reactivateUser`
 * already own that exact behavior, gated by `isAdminRole` alone, and are reused completely unchanged
 * (touching Sprint 6A's own authorization gate would be exactly the kind of already-shipped-file
 * modification the standing "preserve all functionality from Sprints 1–17" instruction rules out).
 *
 * `review_fraud_alert` has no backing data source in this pass — no `fraud_alert` (or equivalent)
 * table exists anywhere in this codebase yet; that is Sprint 19's own future scope. The capability is
 * still declared here (per this sprint's own "Fraud reviewer" role name and the master spec's
 * "Review fraud alerts" bullet) so Sprint 19 has an existing capability to gate against rather than
 * inventing a competing one later.
 *
 * `review_payment_failures` is satisfied by the same `review_audit_logs` method
 * (`AdminCaseReviewService.listAuditEventsForTarget`) applied to an agreement/payment target — every
 * payment failure is already an audited event (Sprint 13/17), so no separate dedicated read path was
 * built for it.
 */
export const ADMIN_CAPABILITIES = [
  "suspend_account",
  "restrict_payment_activity",
  "restrict_new_agreements",
  "restrict_payout",
  "review_verification_status",
  "review_fraud_alert",
  "review_payment_failures",
  "review_dispute",
  "review_audit_logs",
  "manage_support_case",
  "manage_appeal",
  "place_retention_hold",
  "release_retention_hold",
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

export function isAdminCapability(value: string): value is AdminCapability {
  return (ADMIN_CAPABILITIES as readonly string[]).includes(value);
}

export type InternalAdminRole = "support" | "compliance" | "fraud_reviewer" | "admin";

/**
 * "admin" is intentionally absent here — it always has every capability (see
 * `AdminRoleService.requireCapability`), the same structural-bypass precedent as Sprint 4's "owner"
 * being absent from `DEFAULT_ROLE_CAPABILITIES` there, rather than needing to be kept in sync as
 * capabilities are added.
 */
export const DEFAULT_INTERNAL_ROLE_CAPABILITIES: Record<Exclude<InternalAdminRole, "admin">, readonly AdminCapability[]> = {
  support: ["manage_support_case", "review_audit_logs", "review_payment_failures"],
  // "manage_appeal" sits with compliance, not support or fraud_reviewer — an appeal reviewer must
  // never be the same person who made the original restriction decision (see appeal.ts's own CHECK
  // constraint), and compliance is this codebase's natural independent-review role, distinct from
  // fraud_reviewer (who places most of the restrictions being appealed) and support (case
  // administration, not adjudication).
  compliance: ["review_verification_status", "review_dispute", "review_audit_logs", "place_retention_hold", "release_retention_hold", "manage_appeal"],
  fraud_reviewer: ["review_fraud_alert", "review_dispute", "restrict_payment_activity", "restrict_new_agreements", "restrict_payout"],
};
