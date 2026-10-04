/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Requirement 12/28: the single, centralized stable
 * permission vocabulary — every permission key, its category, its human-readable label, and its
 * plain-language explanation live here and ONLY here. No React component may hard-code a permission
 * label/description string; the role editor (Requirement 11/28) renders directly from this catalog.
 * Renaming a role display name never touches this file or any `organization_role_permission` row —
 * permissions are assigned to a role's stable `id`, independent of its current display name
 * (Requirement 11's own "renaming a role must never change permissions").
 */

export type PermissionScope = "organization" | "assigned" | "own" | "team" | "none";

export interface PermissionDefinition {
  key: string;
  category: string;
  label: string;
  description: string;
  /**
   * Requirement 13: "Only expose scope choices for resources where the backend actually supports
   * the scope." Every permission here supports only "organization" today — "assigned"/"own"/"team"
   * are accepted by the schema (organizationRolePermissionScopeEnum) as forward-compatible
   * vocabulary, but no authorization check in this codebase resolves them yet (the AR_AGENT
   * "assigned to me" scoping gap documented since Phase 7/8 remains open). A role editor must
   * never offer a scope choice absent from a permission's own `supportedScopes` — this array is the
   * single source of truth for that gate, not a client-side guess.
   */
  supportedScopes: readonly PermissionScope[];
}

const ORGANIZATION_ONLY: readonly PermissionScope[] = ["organization"];

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  { key: "dashboard.view", category: "Dashboard", label: "View Dashboard", description: "View the organization's dashboard summary.", supportedScopes: ORGANIZATION_ONLY },

  { key: "balances.view", category: "Balances", label: "View Balances", description: "View outstanding balances owed to or by this organization.", supportedScopes: ORGANIZATION_ONLY },
  { key: "balances.create", category: "Balances", label: "Create Balances", description: "Record a new outstanding balance for this organization.", supportedScopes: ORGANIZATION_ONLY },
  { key: "balances.edit", category: "Balances", label: "Edit Balances", description: "Edit the details of an existing balance.", supportedScopes: ORGANIZATION_ONLY },
  { key: "balances.resolve", category: "Balances", label: "Resolve Balances", description: "Mark a balance as paid or written off.", supportedScopes: ORGANIZATION_ONLY },
  { key: "balances.export", category: "Balances", label: "Export Balances", description: "Export balance records to a file.", supportedScopes: ORGANIZATION_ONLY },

  { key: "customers.view", category: "Customers", label: "View Customers", description: "View customer records belonging to this organization.", supportedScopes: ORGANIZATION_ONLY },
  { key: "customers.create", category: "Customers", label: "Create Customers", description: "Add a new customer record.", supportedScopes: ORGANIZATION_ONLY },
  { key: "customers.edit", category: "Customers", label: "Edit Customers", description: "Edit an existing customer record.", supportedScopes: ORGANIZATION_ONLY },
  { key: "customers.archive", category: "Customers", label: "Archive Customers", description: "Archive a customer record belonging to this organization.", supportedScopes: ORGANIZATION_ONLY },
  { key: "customers.export", category: "Customers", label: "Export Customers", description: "Export customer records to a file.", supportedScopes: ORGANIZATION_ONLY },

  { key: "agreements.view", category: "Agreements", label: "View Agreements", description: "View agreements belonging to this organization.", supportedScopes: ORGANIZATION_ONLY },
  {
    key: "agreements.create",
    category: "Agreements",
    label: "Create Agreements",
    description: "Create a new repayment agreement for this organization. Bank/payment-provider authorization rules still apply independently of this permission.",
    supportedScopes: ORGANIZATION_ONLY,
  },
  { key: "agreements.edit", category: "Agreements", label: "Edit Agreements", description: "Edit the terms of a draft agreement.", supportedScopes: ORGANIZATION_ONLY },
  { key: "agreements.send", category: "Agreements", label: "Send Agreements", description: "Send an agreement to a counterparty for review.", supportedScopes: ORGANIZATION_ONLY },
  { key: "agreements.request_changes", category: "Agreements", label: "Request Changes", description: "Request changes to an agreement under review.", supportedScopes: ORGANIZATION_ONLY },
  { key: "agreements.cancel", category: "Agreements", label: "Cancel Agreements", description: "Cancel an agreement before it is fully executed.", supportedScopes: ORGANIZATION_ONLY },
  { key: "agreements.export", category: "Agreements", label: "Export Agreements", description: "Export agreement records to a file.", supportedScopes: ORGANIZATION_ONLY },

  { key: "payments.view", category: "Payments", label: "View Payments", description: "View payment records belonging to this organization.", supportedScopes: ORGANIZATION_ONLY },
  { key: "payments.prepare", category: "Payments", label: "Prepare Payments", description: "Prepare a payment for initiation.", supportedScopes: ORGANIZATION_ONLY },
  {
    key: "payments.initiate",
    category: "Payments",
    label: "Initiate Payments",
    description: "Initiate a payment on behalf of this organization. This is an organizational permission only — it never bypasses bank ownership, provider rules, payout eligibility, or settlement/transaction approval requirements enforced independently by the banking system.",
    supportedScopes: ORGANIZATION_ONLY,
  },
  { key: "payments.approve", category: "Payments", label: "Approve Payments", description: "Approve a prepared payment before it is initiated.", supportedScopes: ORGANIZATION_ONLY },
  { key: "payments.export", category: "Payments", label: "Export Payments", description: "Export payment records to a file.", supportedScopes: ORGANIZATION_ONLY },

  { key: "members.view", category: "Employees", label: "View Team Members", description: "View the organization's team members.", supportedScopes: ORGANIZATION_ONLY },
  { key: "members.invite", category: "Employees", label: "Invite Team Members", description: "Invite a new team member to this organization.", supportedScopes: ORGANIZATION_ONLY },
  { key: "members.edit", category: "Employees", label: "Edit Team Members", description: "Change a team member's assigned role.", supportedScopes: ORGANIZATION_ONLY },
  { key: "members.remove", category: "Employees", label: "Remove Team Members", description: "Remove a team member from this organization.", supportedScopes: ORGANIZATION_ONLY },

  { key: "roles.view", category: "Roles & Permissions", label: "View Roles", description: "View the organization's roles and their permissions.", supportedScopes: ORGANIZATION_ONLY },
  { key: "roles.create", category: "Roles & Permissions", label: "Create Roles", description: "Create a new organization role.", supportedScopes: ORGANIZATION_ONLY },
  { key: "roles.edit", category: "Roles & Permissions", label: "Edit Roles", description: "Rename a role, edit its description, or change its permissions.", supportedScopes: ORGANIZATION_ONLY },
  { key: "roles.delete", category: "Roles & Permissions", label: "Delete Roles", description: "Delete an ordinary (non-protected) organization role.", supportedScopes: ORGANIZATION_ONLY },
  { key: "roles.assign", category: "Roles & Permissions", label: "Assign Roles", description: "Assign a role to a team member.", supportedScopes: ORGANIZATION_ONLY },

  { key: "reports.view", category: "Reports", label: "View Reports", description: "View the organization's reports.", supportedScopes: ORGANIZATION_ONLY },
  { key: "reports.export", category: "Reports", label: "Export Reports", description: "Export reports to a file.", supportedScopes: ORGANIZATION_ONLY },

  { key: "reconciliation.view", category: "Reconciliation", label: "View Reconciliation", description: "View the organization's reconciliation records.", supportedScopes: ORGANIZATION_ONLY },
  { key: "reconciliation.match", category: "Reconciliation", label: "Match Reconciliation", description: "Match reconciliation records.", supportedScopes: ORGANIZATION_ONLY },
  { key: "reconciliation.resolve", category: "Reconciliation", label: "Resolve Reconciliation", description: "Resolve reconciliation exceptions.", supportedScopes: ORGANIZATION_ONLY },
  { key: "reconciliation.export", category: "Reconciliation", label: "Export Reconciliation", description: "Export reconciliation records to a file.", supportedScopes: ORGANIZATION_ONLY },

  { key: "documents.view", category: "Documents", label: "View Documents", description: "View documents belonging to this organization.", supportedScopes: ORGANIZATION_ONLY },
  { key: "documents.upload", category: "Documents", label: "Upload Documents", description: "Upload a new document.", supportedScopes: ORGANIZATION_ONLY },
  { key: "documents.edit_metadata", category: "Documents", label: "Edit Document Details", description: "Edit a document's metadata (type, related records).", supportedScopes: ORGANIZATION_ONLY },
  { key: "documents.archive", category: "Documents", label: "Archive Documents", description: "Archive a document.", supportedScopes: ORGANIZATION_ONLY },
  { key: "documents.export", category: "Documents", label: "Export Documents", description: "Export/download documents.", supportedScopes: ORGANIZATION_ONLY },

  { key: "audit.view", category: "Audit History", label: "View Audit History", description: "View the organization's audit history. Audit history can never be edited or deleted by ordinary organization users.", supportedScopes: ORGANIZATION_ONLY },
  { key: "audit.export", category: "Audit History", label: "Export Audit History", description: "Export audit history to a file.", supportedScopes: ORGANIZATION_ONLY },

  { key: "integrations.view", category: "Integrations", label: "View Integrations", description: "View the organization's connected integrations.", supportedScopes: ORGANIZATION_ONLY },
  { key: "integrations.connect", category: "Integrations", label: "Connect Integrations", description: "Connect a new integration.", supportedScopes: ORGANIZATION_ONLY },
  { key: "integrations.configure", category: "Integrations", label: "Configure Integrations", description: "Configure an existing integration.", supportedScopes: ORGANIZATION_ONLY },
  { key: "integrations.disconnect", category: "Integrations", label: "Disconnect Integrations", description: "Disconnect an integration.", supportedScopes: ORGANIZATION_ONLY },

  { key: "organization.view", category: "Organization Settings", label: "View Organization Settings", description: "View the organization's profile and settings.", supportedScopes: ORGANIZATION_ONLY },
  { key: "organization.edit", category: "Organization Settings", label: "Edit Organization Settings", description: "Edit the organization's profile and settings.", supportedScopes: ORGANIZATION_ONLY },

  { key: "subscription.view", category: "Billing & Subscription", label: "View Subscription", description: "View the organization's Paid2You subscription plan and usage.", supportedScopes: ORGANIZATION_ONLY },
  { key: "subscription.manage", category: "Billing & Subscription", label: "Manage Subscription", description: "Change plan, cancel, or reactivate the organization's Paid2You subscription.", supportedScopes: ORGANIZATION_ONLY },
  { key: "subscription.payment_method.manage", category: "Billing & Subscription", label: "Manage Payment Method", description: "Add or change the payment method used for the Paid2You subscription.", supportedScopes: ORGANIZATION_ONLY },
  { key: "subscription.invoices.view", category: "Billing & Subscription", label: "View Invoices", description: "View Paid2You subscription invoices and receipts.", supportedScopes: ORGANIZATION_ONLY },
  { key: "subscription.invoices.export", category: "Billing & Subscription", label: "Export Invoices", description: "Export/download Paid2You subscription invoices and receipts.", supportedScopes: ORGANIZATION_ONLY },
] as const;

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_CATALOG.map((p) => p.key));
const PERMISSION_BY_KEY: ReadonlyMap<string, PermissionDefinition> = new Map(PERMISSION_CATALOG.map((p) => [p.key, p]));

export function isPermissionKey(value: string): boolean {
  return PERMISSION_KEY_SET.has(value);
}

export function getPermissionDefinition(key: string): PermissionDefinition | undefined {
  return PERMISSION_BY_KEY.get(key);
}

export function isScopeSupportedForPermission(key: string, scope: PermissionScope): boolean {
  const definition = PERMISSION_BY_KEY.get(key);
  if (!definition) return false;
  return definition.supportedScopes.includes(scope);
}
