/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02): `OrganizationResourceType` extracted out of
 * organizationAuthorizationService.ts (which is "server-only") into its own plain module so client
 * components (e.g. OrganizationUnavailableResource) can import the type/list without pulling in any
 * server-only code — this file has no behavior of its own, just the shared vocabulary.
 */
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

export const ORGANIZATION_RESOURCE_TYPES: readonly OrganizationResourceType[] = [
  "dashboard",
  "outstanding_balances",
  "customers",
  "agreements",
  "payments",
  "employees",
  "reports",
  "reconciliation",
  "documents",
  "audit_history",
  "integrations",
  "organization_settings",
  "subscription",
];
