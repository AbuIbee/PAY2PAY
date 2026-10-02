import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pricingPlanKindEnum, profileKindEnum, subscriptionStatusEnum } from "./enums";

/**
 * Sprint 3 (docs/sprints/SPRINT_03_Personal_Business_Profiles.md) pricing/
 * account-plan architecture (master spec §19). A catalog table, not
 * per-user data — admin-managed, configurable, never hard-coded in
 * application code. All fees are integer minor units (never float, per
 * master spec §37 / FR-MONEY-001), consistent with every other money field
 * in this project.
 *
 * `free_agreement_allowance` / `free_included_payments_allowance` implement
 * "the free-plan limit should be based on: number of agreements, number of
 * included successful payments... do not use total dollar amount as the
 * primary free-tier threshold" — both are counts, never a currency amount.
 */
export const pricingPlan = pgTable("pricing_plan", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  kind: pricingPlanKindEnum("kind").notNull(),
  code: text("code").notNull().unique(), // e.g. 'personal_free', 'business_standard'
  name: text("name").notNull(),
  description: text("description"),
  monthlyFeeMinorUnits: integer("monthly_fee_minor_units"),
  annualFeeMinorUnits: integer("annual_fee_minor_units"), // business: "standard annual fee"
  perAgreementFeeMinorUnits: integer("per_agreement_fee_minor_units"),
  perSuccessfulPaymentFeeMinorUnits: integer("per_successful_payment_fee_minor_units"), // business: "small transaction fee"
  // Free-tier allowance — counts, never a dollar amount (see doc comment above).
  freeAgreementAllowance: integer("free_agreement_allowance"),
  freeIncludedPaymentsAllowance: integer("free_included_payments_allowance"),
  isActive: boolean("is_active").notNull().default(true),
  // Pricing changes apply prospectively only (Sprint 3's explicit requirement)
  // — this plan definition takes effect from this timestamp forward; it does
  // not retroactively alter any already-signed agreement's fee terms, which
  // (once Sprint 5 builds agreement_version) snapshot their own fee terms at
  // signing time rather than referencing this table live.
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * Links a profile (personal or business) to its current/historical pricing
 * plan. Multiple rows per profile over time (status distinguishes
 * active/canceled) — never updated in place, so history of what plan was in
 * effect when is preserved, mirroring identity_verification_record's
 * insert-per-decision pattern.
 *
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE" (2026-10-02): this table IS
 * the foundation for "Organization Subscription" — a business_profile's subscription is just a row
 * here with `profileKind = 'business'`, `profileId = business_profile.id`, exactly like every other
 * subscription. The subscription belongs to the profile (the organization), never to the owning
 * user, which this table's shape already guaranteed before this change — nothing here was altered
 * to achieve that. `currentPeriodStart`/`currentPeriodEnd` are new, nullable, additive columns for
 * the billing-cycle concept the existing `startedAt`/`endedAt` lifecycle fields don't cover; they
 * carry no interest/APR/time-based-balance-growth semantics of any kind — purely "which billing
 * period is this subscription currently in," entirely separate from any agreement's own debt terms.
 */
export const subscription = pgTable("subscription", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  profileKind: profileKindEnum("profile_kind").notNull(),
  profileId: uuid("profile_id").notNull(), // personal_profile.id or business_profile.id
  pricingPlanId: uuid("pricing_plan_id")
    .notNull()
    .references(() => pricingPlan.id),
  status: subscriptionStatusEnum("status").notNull().default("active"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * B2B Organization architecture: the entitlement catalog — which features/limits come bundled with
 * each `pricing_plan` row. Admin-managed catalog data (mirrors `pricing_plan` itself), never
 * per-business data; a business's actual entitlements are resolved by joining its active
 * `subscription` -> `pricing_plan` -> these rows (see src/lib/organizations/entitlements.ts).
 *
 * `enabled` and `limitValue` are deliberately independent, not a single overloaded field:
 *   - `enabled = false` — the feature is off for this plan, `limitValue` is irrelevant.
 *   - `enabled = true`, `limitValue IS NULL` — the feature is on with NO cap (unlimited/not
 *     applicable). NULL is used for "unlimited" precisely so a real, deliberate cap of zero is
 *     never confused with "no limit" — `limitValue = 0` means a hard cap of zero, not unlimited.
 *   - `enabled = true`, `limitValue = N` (N > 0) — the feature is on with an explicit numeric cap
 *     (e.g. `staff_seats` = 5).
 * Exactly one row per (pricing_plan, feature_key) — never a second, competing source of truth for
 * what a plan includes.
 */
export const pricingPlanEntitlement = pgTable(
  "pricing_plan_entitlement",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    pricingPlanId: uuid("pricing_plan_id")
      .notNull()
      .references(() => pricingPlan.id),
    featureKey: text("feature_key").notNull(), // e.g. 'business_dashboard', 'staff_seats', 'api_access'
    enabled: boolean("enabled").notNull().default(true),
    // NULL = unlimited/not applicable (see table doc comment); never use 0 to mean "unlimited".
    limitValue: integer("limit_value"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("pricing_plan_entitlement_plan_feature_unique").on(table.pricingPlanId, table.featureKey)],
).enableRLS();
