import { sql } from "drizzle-orm";
import { check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import { profileKindEnum } from "./enums";
import { businessProfile } from "./identity";

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE" (2026-10-02): the minimum
 * domain model required for B2B receivables inside a Business Workspace — not a full ERP. Both
 * tables are brand-new (no existing equivalent was found in Phase 0's inventory) and scoped
 * strictly to one `business_profile` ("Organization") each; every read/write against either table
 * must be filtered by the caller's authorized `business_profile_id`, enforced in
 * src/lib/organizations/* service code (this schema file enforces NOT NULL/FK shape only — see
 * identity.ts's own doc comment on why RLS cannot carry this weight in this database).
 *
 * RIBA / FINANCIAL DESIGN GUARDRAIL: neither table has, or may ever gain, an interest-rate, APR,
 * compounding, or time-based-balance-growth column. `original_amount_minor_units`/
 * `agreed_amount_minor_units` are fixed figures an agreement/invoice already established — this
 * schema never recomputes or grows them on its own account.
 */

export const businessCustomerStatusEnum = pgEnum("business_customer_status", ["active", "archived"]);

/**
 * A counterparty (personal or business profile) that a business has an ongoing receivables
 * relationship with. Deliberately reuses the existing `profileKind`/`profileId` polymorphic
 * reference pattern (agreement.ts, relationship.ts) rather than inventing a new party concept — the
 * counterparty here is never required to hold a Business subscription of their own (see the
 * architecture's own "Critical Counterparty Rule").
 */
export const businessCustomer = pgTable(
  "business_customer",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    businessProfileId: uuid("business_profile_id")
      .notNull()
      .references(() => businessProfile.id),
    counterpartyProfileKind: profileKindEnum("counterparty_profile_kind").notNull(),
    counterpartyProfileId: uuid("counterparty_profile_id").notNull(),
    externalCustomerReference: text("external_customer_reference"),
    status: businessCustomerStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("business_customer_org_counterparty_unique").on(
      table.businessProfileId,
      table.counterpartyProfileKind,
      table.counterpartyProfileId,
    ),
  ],
).enableRLS();

export const businessObligationStatusEnum = pgEnum("business_obligation_status", ["open", "paid", "written_off"]);

/**
 * A business's outstanding balance owed by one of its customers — the "Outstanding Balance" /
 * Business Obligation concept the Business Workspace needs. Links to an `agreement` where one
 * exists (an obligation is the business-facing AR view of an agreement's balance, never a
 * competing concept); `agreementId` is nullable because a business may track a receivable before
 * (or without) a formal Paid2You agreement existing for it yet.
 */
export const businessObligation = pgTable(
  "business_obligation",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    businessProfileId: uuid("business_profile_id")
      .notNull()
      .references(() => businessProfile.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => businessCustomer.id),
    agreementId: uuid("agreement_id").references(() => agreement.id),
    externalReference: text("external_reference"),
    invoiceReference: text("invoice_reference"),
    originalAmountMinorUnits: integer("original_amount_minor_units").notNull(),
    agreedAmountMinorUnits: integer("agreed_amount_minor_units").notNull(),
    status: businessObligationStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("business_obligation_original_amount_positive", sql`${table.originalAmountMinorUnits} > 0`),
    check("business_obligation_agreed_amount_positive", sql`${table.agreedAmountMinorUnits} > 0`),
    // Organization-scoped listing ("outstanding balances for this org") and customer-detail
    // listing ("obligations for this customer") are the two realistic query patterns; unlike
    // business_customer's compound unique index, nothing here already leads with either column.
    index("business_obligation_business_profile_id_idx").on(table.businessProfileId),
    index("business_obligation_customer_id_idx").on(table.customerId),
  ],
).enableRLS();
