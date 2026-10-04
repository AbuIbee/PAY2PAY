/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 6/Requirement 10: the EXACT default
 * permission sets a new organization's four seeded roles receive — copied verbatim from the order's
 * own Section 6 list, nothing added, nothing omitted. Every entry is scope "organization" (the only
 * scope any permission actually supports today — see permissionCatalog.ts's own doc comment).
 *
 * Owner is deliberately NOT a template here: it receives the COMPLETE permission catalog (every key
 * in PERMISSION_CATALOG), computed directly from that catalog rather than duplicated as a hand-typed
 * list that could silently drift out of sync as new permissions are added — see
 * organizationRoleService.ts's seedDefaultRolesForNewOrganization, which is the single place that
 * reads both this file and the catalog together.
 */
import { PERMISSION_CATALOG } from "./permissionCatalog";

export interface DefaultRoleTemplate {
  displayName: string;
  description: string;
  sortOrder: number;
  permissionKeys: readonly string[];
}

const MANAGER_PERMISSION_KEYS: readonly string[] = [
  "dashboard.view",
  "balances.view",
  "balances.create",
  "balances.edit",
  "balances.resolve",
  "balances.export",
  "customers.view",
  "customers.create",
  "customers.edit",
  "customers.archive",
  "customers.export",
  "agreements.view",
  "agreements.create",
  "agreements.edit",
  "agreements.send",
  "agreements.cancel",
  "agreements.export",
  "payments.view",
  "payments.prepare",
  "payments.initiate",
  "payments.export",
  "members.view",
  "members.invite",
  "members.edit",
  "roles.view",
  "roles.assign",
  "reports.view",
  "reports.export",
  "reconciliation.view",
  "reconciliation.match",
  "reconciliation.resolve",
  "reconciliation.export",
  "documents.view",
  "documents.upload",
  "documents.edit_metadata",
  "documents.archive",
  "documents.export",
  "audit.view",
  "audit.export",
  "integrations.view",
  "organization.view",
  "organization.edit",
  "subscription.view",
];

const EMPLOYEE_2_PERMISSION_KEYS: readonly string[] = [
  "dashboard.view",
  "balances.view",
  "balances.create",
  "balances.edit",
  "customers.view",
  "customers.create",
  "customers.edit",
  "agreements.view",
  "agreements.create",
  "agreements.edit",
  "agreements.send",
  "payments.view",
  "reports.view",
  "reconciliation.view",
  "documents.view",
  "documents.upload",
  "documents.edit_metadata",
];

const EMPLOYEE_3_PERMISSION_KEYS: readonly string[] = [
  "dashboard.view",
  "balances.view",
  "customers.view",
  "agreements.view",
  "payments.view",
  "reports.view",
  "documents.view",
];

export const DEFAULT_ROLE_TEMPLATES: Readonly<Record<"manager" | "employee2" | "employee3", DefaultRoleTemplate>> = {
  manager: {
    displayName: "Manager",
    description: "Day-to-day operational management: balances, customers, agreements, payments, reporting, and team oversight. Does not manage billing, integrations, or role/permission structure by default.",
    sortOrder: 1,
    permissionKeys: MANAGER_PERMISSION_KEYS,
  },
  employee2: {
    displayName: "Employee 2",
    description: "Default operational role: create and edit balances, customers, and agreements. No employee, role, subscription, integration, or organization administration by default.",
    sortOrder: 2,
    permissionKeys: EMPLOYEE_2_PERMISSION_KEYS,
  },
  employee3: {
    displayName: "Employee 3",
    description: "Default read-oriented role: view balances, customers, agreements, payments, reports, and documents. No mutations by default.",
    sortOrder: 3,
    permissionKeys: EMPLOYEE_3_PERMISSION_KEYS,
  },
};

/** Owner receives the complete catalog — see this file's own doc comment for why it is computed, not hand-listed. */
export function ownerPermissionKeys(): readonly string[] {
  return PERMISSION_CATALOG.map((p) => p.key);
}
