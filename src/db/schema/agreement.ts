import { sql } from "drizzle-orm";
import { boolean, date, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import {
  agreementPartyRoleEnum,
  agreementStatusEnum,
  feeAllocationEnum,
  installmentItemStatusEnum,
  paymentFrequencyEnum,
  profileKindEnum,
} from "./enums";
import { userAccount } from "./identity";
import { relationship } from "./relationship";

/**
 * Sprint 5 (docs/sprints/SPRINT_05_Agreement_Engine.md) agreement engine.
 * Matches docs/DATA_MODEL.md §4's illustrative `agreement`/`agreement_version`/`agreement_party`/
 * `installment_schedule_item` shapes, narrowed to this sprint's scope: no `signature_event`
 * (Sprint 6 owns real electronic-signature evidence capture — IP, device, consent, auth method),
 * no `witness_attestation` (Sprint 7), no `retention_until`/`legal_hold` (Sprint 18/20), and
 * `agreement_party.role` only supports creditor/debtor for now (witness deferred).
 */

export const agreement = pgTable("agreement", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  creditorProfileKind: profileKindEnum("creditor_profile_kind").notNull(),
  creditorProfileId: uuid("creditor_profile_id").notNull(),
  debtorProfileKind: profileKindEnum("debtor_profile_kind").notNull(),
  debtorProfileId: uuid("debtor_profile_id").notNull(),
  status: agreementStatusEnum("status").notNull().default("draft"),
  currency: text("currency").notNull().default("USD"),
  country: text("country").notNull().default("US"),
  // Not FK-constrained (matches docs/DATA_MODEL.md §4's own "illustrative" note) — agreement_version
  // references agreement.id, so a real FK here would be circular. Application code is the sole
  // writer and always keeps this in sync with agreement_version's rows.
  currentVersionId: uuid("current_version_id"),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => userAccount.id),
  // Sprint 18A (docs/sprints/Sprint_18A_CooperativeAccountPairing_FinancialAccountLinking_
  // RelationshipArchitecture.md) addition: additive, nullable — every pre-Sprint-18A agreement has no
  // relationship and is untouched; this sprint's own "for existing records, determine a migration/
  // backfill strategy suitable for development/test data... do not create invalid production
  // assumptions" is satisfied by leaving pre-existing rows null rather than fabricating a backfilled
  // relationship history that never actually happened.
  relationshipId: uuid("relationship_id").references(() => relationship.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}).enableRLS();

export const agreementVersion = pgTable(
  "agreement_version",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => agreement.id),
    versionNumber: integer("version_number").notNull(),
    // Not FK-constrained — self-referential FK adds real complexity for zero benefit in Sprint 5,
    // which never creates a second version (amendments arrive in Sprint 14/15). Reserved for that.
    parentVersionId: uuid("parent_version_id"),
    isOriginal: boolean("is_original").notNull().default(true),
    producedBy: text("produced_by").notNull(), // 'initial_signing' — Sprint 14/15 add amendment kinds
    // Closed-vocabulary fields get real typed columns rather than being buried in `terms` where an
    // enum constraint wouldn't be DB-enforced.
    frequency: paymentFrequencyEnum("frequency").notNull(),
    feeAllocation: feeAllocationEnum("fee_allocation").notNull(),
    // Remaining required-field-set snapshot (FR-AGR-002): category, description, amounts,
    // early-payoff/hardship/partial-payment/settlement/dispute-procedure terms, supporting-evidence
    // references. Creditor/debtor identity lives on `agreement`/`agreement_party`, not duplicated
    // here; the computed schedule lives in installment_schedule_item, not duplicated here either.
    terms: jsonb("terms").notNull(),
    documentHash: text("document_hash"), // populated once signed (FR-SIG-001, computed by Sprint 6 later)
    // Minimal, version-scoped signing-intent tracking (who has signed *this* version) — not
    // Sprint 6's `signature_event` evidence bundle (IP, device, consent, auth method), which Sprint
    // 6 layers on top of / supersedes. Version-scoped (not agreement_party-scoped) so a future
    // amendment's new version correctly starts both back at NULL, requiring fresh signatures
    // (FR-AGR-007 AC2).
    creditorSignedAt: timestamp("creditor_signed_at", { withTimezone: true }),
    debtorSignedAt: timestamp("debtor_signed_at", { withTimezone: true }),
    // Set only once both roles above have signed — the version is locked from that point on.
    signedAt: timestamp("signed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("agreement_version_agreement_number_unique").on(table.agreementId, table.versionNumber)],
).enableRLS();

export const agreementParty = pgTable(
  "agreement_party",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => agreement.id),
    role: agreementPartyRoleEnum("role").notNull(),
    profileKind: profileKindEnum("profile_kind").notNull(),
    profileId: uuid("profile_id").notNull(),
  },
  (table) => [uniqueIndex("agreement_party_agreement_role_unique").on(table.agreementId, table.role)],
).enableRLS();

export const installmentScheduleItem = pgTable(
  "installment_schedule_item",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    agreementVersionId: uuid("agreement_version_id")
      .notNull()
      .references(() => agreementVersion.id),
    sequenceNumber: integer("sequence_number").notNull(), // 0 = first payment
    dueDate: date("due_date").notNull(),
    amountMinorUnits: integer("amount_minor_units").notNull(), // integer minor units, never float (FR-MONEY-001)
    status: installmentItemStatusEnum("status").notNull().default("scheduled"),
  },
  (table) => [
    uniqueIndex("installment_schedule_item_version_sequence_unique").on(table.agreementVersionId, table.sequenceNumber),
  ],
).enableRLS();
