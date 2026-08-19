import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businessProfile, personalProfile, userAccount } from "./identity";
import { relationship, relationshipParticipant } from "./relationship";
import {
  bankAccountSubtypeEnum,
  financialAccountStatusEnum,
  financialAccountTypeEnum,
  financialAccountUsageEnum,
  relationshipFinancialAccountAssignmentStatusEnum,
} from "./enums";

/**
 * Sprint 18A §14/§15/§18: a party-owned, reusable financial account — the missing layer between "a
 * verified bank account exists" (previously only representable per-agreement, via Sprint 11's
 * `ach_mandate.bank_account_ref` / Sprint 12's `debit_card_method.card_token`) and "this party can
 * reuse that same account across multiple relationships." This table does **not** replace or weaken
 * either Sprint 11/12 table — both remain exactly as built, still the sole record of a per-agreement
 * mandate / authorization (a real compliance concept: re-authorizing per agreement is correct, not
 * a limitation to fix). `financial_account` only adds the reusable identity layer those two tables
 * never had: `ach_mandate`/`debit_card_method` each gain an additive, nullable `financial_account_id`
 * (see ach.ts/debitCard.ts) so a *new* mandate/card row created through the relationship flow can
 * reuse an already-known provider token instead of re-collecting it, while every pre-Sprint-18A row
 * simply has `financial_account_id = null`, completely unaffected.
 *
 * `provider_account_ref` mirrors `ach_mandate.bank_account_ref`/`debit_card_method.card_token`'s
 * identical "opaque provider-issued reference, never a raw account/routing number or PAN" precedent.
 * Ownership uses the same exactly-one-party-target CHECK pattern as `relationship_participant`.
 */
export const financialAccount = pgTable(
  "financial_account",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    individualProfileId: uuid("individual_profile_id").references(() => personalProfile.id),
    organizationId: uuid("organization_id").references(() => businessProfile.id),
    accountType: financialAccountTypeEnum("account_type").notNull(),
    providerName: text("provider_name").notNull(),
    providerAccountRef: text("provider_account_ref").notNull(),
    maskedLast4: text("masked_last4"),
    institutionDisplayName: text("institution_display_name"),
    // Debit-card connector (Phase 21) remediation: card-specific fields, nullable and meaningful only
    // when accountType = 'debit_card' — required by RelationshipFinancialAccountService.addAccount's
    // own validation for that type (debit_card_method.expires_at_month/year are NOT NULL, so a
    // relationship-driven card registration must supply real values, never a placeholder). Storing
    // last4/brand/expiry as plain columns is standard, non-sensitive display metadata, matching
    // debit_card_method's own identical Sprint 12 precedent (its own doc comment: "PCI DSS permits
    // storing the last four digits, brand, and expiry outside full PCI scope").
    cardExpiryMonth: integer("card_expiry_month"),
    cardExpiryYear: integer("card_expiry_year"),
    cardBrand: text("card_brand"),
    // Phase 6A: bank-specific, nullable, meaningful only when accountType = 'bank_account' — mirrors
    // the card fields above's identical pattern. Never a routing/account number; see
    // docs/PRODUCTION_PROVIDER_READINESS.md and this table's own doc comment for the "opaque
    // provider reference, never a raw credential" precedent this column follows.
    bankAccountSubtype: bankAccountSubtypeEnum("bank_account_subtype"),
    status: financialAccountStatusEnum("status").notNull().default("pending_verification"),
    addedByUserId: uuid("added_by_user_id")
      .notNull()
      .references(() => userAccount.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "financial_account_exactly_one_party",
      sql`(${table.individualProfileId} IS NOT NULL AND ${table.organizationId} IS NULL) OR (${table.individualProfileId} IS NULL AND ${table.organizationId} IS NOT NULL)`,
    ),
  ],
).enableRLS();

/**
 * Sprint 18A §19: a relationship's own record of which party-owned `financial_account` is currently
 * (or was historically) serving as its funding or payout slot. Replacement never overwrites this row
 * — `replace` (see relationshipFinancialAccountService.ts) inserts a new `active` row and marks the
 * prior one `superseded` via `superseded_by`, preserving full history (this sprint's own "do not
 * overwrite history").
 */
export const relationshipFinancialAccount = pgTable(
  "relationship_financial_account",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    relationshipId: uuid("relationship_id")
      .notNull()
      .references(() => relationship.id),
    relationshipParticipantId: uuid("relationship_participant_id")
      .notNull()
      .references(() => relationshipParticipant.id),
    financialAccountId: uuid("financial_account_id")
      .notNull()
      .references(() => financialAccount.id),
    usage: financialAccountUsageEnum("usage").notNull(),
    status: relationshipFinancialAccountAssignmentStatusEnum("status").notNull().default("active"),
    selectedByUserId: uuid("selected_by_user_id")
      .notNull()
      .references(() => userAccount.id),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    // Not FK-constrained — points to the assignment that replaced this one, which is created *after*
    // this row already exists; same "would-be-circular, application-enforced" precedent as
    // agreement.ts's currentVersionId / ach.ts's supersedesMandateId.
    supersededBy: uuid("superseded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Only one *active* assignment may occupy a given (relationship, usage) slot at a time — the
    // concrete mechanism behind "only eligible active assignment may occupy a required slot."
    uniqueIndex("relationship_financial_account_active_slot_unique")
      .on(table.relationshipId, table.usage)
      .where(sql`${table.status} = 'active'`),
  ],
).enableRLS();
