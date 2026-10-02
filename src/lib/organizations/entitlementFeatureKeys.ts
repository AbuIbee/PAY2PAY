/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 8 (2026-10-02).
 * Canonical entitlement feature keys — the `pricing_plan_entitlement.feature_key` catalog has no
 * seed data anywhere yet (the table is brand new, introduced this same architecture), so there is
 * no existing agreement-related key to reuse or conflict with. Keys are plain, stable identifiers
 * used in `EntitlementService.entitled()`/`getEntitlementLimit()` calls — never an arbitrary
 * display label.
 */
export const ORGANIZATION_AGREEMENTS_FEATURE_KEY = "organization_agreements";
