import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
