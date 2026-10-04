import { describe, expect, it } from "vitest";
import type { StaffRole } from "@/lib/staff/capabilities";
import { translatedPermissionKeysForLegacyRole } from "./legacyRoleMigration";
import { PERMISSION_CATALOG } from "./permissionCatalog";

/**
 * "PAID2YOU — FINAL RBAC AUTHORIZATION CUTOVER", Step 8/33/34: an explicit, exhaustive, test-backed
 * legacy authorization parity matrix — every permission key in the catalog, against every legacy
 * StaffRole, with the EXACT boolean the pre-cutover system granted (the old
 * `OrganizationAuthorizationService.canReadOrganizationResource`/`StaffService.hasCapability` duo —
 * see legacyRoleMigration.ts's own doc comments for the derivation). `translatedPermissionKeysForLegacyRole`
 * is the single function responsible for reproducing this parity, and it is the ONLY thing this file
 * tests — a change to that function that silently drifts from history fails here first, before it can
 * ever reach a real authorization decision.
 *
 * This is deliberately a DATA table, not prose: reviewers (engineering or product) can check one row
 * at a time against the historical capability model without reading code.
 *
 * `true` = this legacy role had this effective access before the cutover (and must still have it);
 * `false` = it did not (and must still not).
 */
const PARITY_MATRIX: Record<string, Record<Exclude<StaffRole, "OWNER">, boolean>> = {
  // Ambient — every active member could read these ordinary resources (Section 4's own doc comment).
  "dashboard.view": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: true },
  "balances.view": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: true },
  "customers.view": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: true },
  "agreements.view": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: true },
  "payments.view": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: true },
  "members.view": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: true },
  "reports.view": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: true },
  "documents.view": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: true },

  // manage_balances (FINANCE_ADMIN, AR_MANAGER, AR_AGENT all have it; VIEWER never does).
  "balances.create": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },
  "balances.edit": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },
  "balances.resolve": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },
  "balances.export": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },

  // manage_customers (FINANCE_ADMIN, AR_MANAGER, AR_AGENT all have it; VIEWER never does).
  "customers.create": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },
  "customers.edit": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },
  "customers.archive": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },
  "customers.export": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },

  // manage_agreements — the one Phase 8 conservative-policy boundary: AR_MANAGER has it, AR_AGENT
  // deliberately does NOT (this is the exact distinction the Final RBAC Authorization Cutover was
  // required to preserve byte-for-byte — see agreementWorkspaceService.ts's own doc comment).
  "agreements.create": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: false, VIEWER: false },
  "agreements.edit": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: false, VIEWER: false },
  "agreements.send": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: false, VIEWER: false },
  "agreements.cancel": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: false, VIEWER: false },
  "agreements.export": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: false, VIEWER: false },
  // Never granted by `manage_agreements` (the new "Manager" template also lacks it) — no legacy role
  // ever had an equivalent of this new, finer-grained permission.
  "agreements.request_changes": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },

  // manage_documents (FINANCE_ADMIN, AR_MANAGER, AR_AGENT all have it; VIEWER never does).
  "documents.upload": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },
  "documents.edit_metadata": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },
  "documents.archive": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },
  "documents.export": { FINANCE_ADMIN: true, AR_MANAGER: true, AR_AGENT: true, VIEWER: false },

  // change_payout_configuration / approve_high_value_action / approve_partial_payment — FINANCE_ADMIN
  // only; AR_MANAGER/AR_AGENT/VIEWER never had payment-preparation or approval capabilities.
  "payments.prepare": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "payments.approve": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  // Never granted by any legacy capability — no legacy role ever had an equivalent.
  "payments.initiate": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "payments.export": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },

  // send_invitation / manage_staff — FINANCE_ADMIN only.
  "members.invite": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "members.edit": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "members.remove": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "roles.view": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "roles.assign": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  // Never granted by `manage_staff` (no legacy capability mapped to role CRUD) — no legacy role ever
  // had an equivalent of these new, finer-grained permissions.
  "roles.create": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "roles.edit": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "roles.delete": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },

  // export_records / view_reports — FINANCE_ADMIN only for export; view_reports is ambient-equivalent
  // for all three operational roles too (view_reports itself maps onto the already-ambient reports.view).
  "reports.export": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },

  // manage_reconciliation — FINANCE_ADMIN only (a SENSITIVE_ORGANIZATION_RESOURCE_CAPABILITY-gated
  // resource pre-cutover, Section 4's own doc comment — never ambient for AR_MANAGER/AR_AGENT/VIEWER).
  "reconciliation.view": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "reconciliation.match": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "reconciliation.resolve": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "reconciliation.export": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },

  // view_audit_history — FINANCE_ADMIN only (also a sensitive resource pre-cutover).
  "audit.view": { FINANCE_ADMIN: true, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  // Never granted by `view_audit_history` (read-only in the legacy model) — no legacy role ever had an
  // equivalent of this new, finer-grained export permission.
  "audit.export": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },

  // manage_integrations / manage_organization_settings / manage_subscription — NO legacy non-owner
  // role ever held these (sensitive resources, OWNER-only in practice pre-cutover).
  "integrations.view": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "integrations.connect": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "integrations.configure": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "integrations.disconnect": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "organization.view": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "organization.edit": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "subscription.view": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "subscription.manage": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "subscription.payment_method.manage": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "subscription.invoices.view": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
  "subscription.invoices.export": { FINANCE_ADMIN: false, AR_MANAGER: false, AR_AGENT: false, VIEWER: false },
};

const NON_OWNER_ROLES: readonly Exclude<StaffRole, "OWNER">[] = ["FINANCE_ADMIN", "AR_MANAGER", "AR_AGENT", "VIEWER"];

describe("legacy authorization parity matrix (Final RBAC Authorization Cutover, Step 8/33/34)", () => {
  it("the matrix itself covers every permission key in the live catalog — no silent gaps", () => {
    const catalogKeys = new Set(PERMISSION_CATALOG.map((p) => p.key));
    expect(new Set(Object.keys(PARITY_MATRIX))).toEqual(catalogKeys);
  });

  describe.each(NON_OWNER_ROLES)("%s", (role) => {
    const translated = new Set(translatedPermissionKeysForLegacyRole(role));

    it.each(Object.entries(PARITY_MATRIX))("%s", (permissionKey, expectedByRole) => {
      expect(translated.has(permissionKey)).toBe(expectedByRole[role]);
    });
  });

  it("OWNER translates to the FULL permission catalog — every key, unconditionally", () => {
    const translated = new Set(translatedPermissionKeysForLegacyRole("OWNER"));
    for (const { key } of PERMISSION_CATALOG) {
      expect(translated.has(key)).toBe(true);
    }
    expect(translated.size).toBe(PERMISSION_CATALOG.length);
  });
});
