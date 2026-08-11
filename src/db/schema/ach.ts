import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import { achMandateStatusEnum, profileKindEnum } from "./enums";

/**
 * Sprint 11 (docs/sprints/SPRINT_11_ACH_Sandbox.md): the borrower's mandate/authorization to debit
 * their bank account for a specific agreement — "authorization stored per FR-SIG-001/
 * FR-PAYMETHOD-002" (docs/PAYMENT_ARCHITECTURE.md §1). Scoped to one agreement, not the payer
 * profile generally, since a payer may authorize different bank accounts for different debts.
 * `bank_account_ref` is an opaque provider-issued token — never a raw routing/account number,
 * matching Sprint 9's "never store... raw routing/account numbers... prefer tokens/provider IDs."
 * Mandates are append-only: revoking sets `revoked_at`/`revoked_reason` on the existing row (never
 * deleted, preserving the authorization history an unauthorized-payment claim would need per
 * FR-UPAY-003); a bank change creates an entirely new row and links back via
 * `supersedes_mandate_id`, rather than mutating the old mandate's bank reference in place.
 */
export const achMandate = pgTable("ach_mandate", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreement.id),
  payerProfileKind: profileKindEnum("payer_profile_kind").notNull(),
  payerProfileId: uuid("payer_profile_id").notNull(),
  bankAccountRef: text("bank_account_ref").notNull(),
  status: achMandateStatusEnum("status").notNull().default("active"),
  authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  // Set on the *new* mandate created by a bank-change hook, pointing back at the mandate it
  // replaces — never the other way around, so a mandate's own history is a simple forward chain.
  // Not FK-constrained — same precedent as agreement.ts's `agreementVersion.parentVersionId`
  // (self-referential FK adds real complexity for zero benefit at this schema's scale).
  supersedesMandateId: uuid("supersedes_mandate_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
