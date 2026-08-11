import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import { paymentAttempt } from "./payment";
import {
  ledgerAccountTypeEnum,
  ledgerEntryTypeEnum,
  ledgerPostingDirectionEnum,
  reconciliationExceptionStatusEnum,
  reconciliationExceptionTypeEnum,
} from "./enums";
import { userAccount } from "./identity";

/**
 * Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md): the internal double-entry-style
 * shadow ledger, matching docs/PAYMENT_ARCHITECTURE.md §14. Every account is scoped to exactly one
 * agreement — there is no platform-wide singleton account — so every balance is directly traceable
 * to "the appropriate agreement" (this sprint's requirement #4) without a join through anything
 * else. Rows are created lazily (get-or-create) by `ledgerService.ts`, never pre-seeded.
 */
export const ledgerAccount = pgTable(
  "ledger_account",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountType: ledgerAccountTypeEnum("account_type").notNull(),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => agreement.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("ledger_account_type_agreement_unique").on(table.accountType, table.agreementId)],
).enableRLS();

/**
 * One row per balanced financial event ("journal entry"), always linked to the `payment_attempt`
 * that caused it and, through it, transitively to the agreement, provider reference, and audit
 * context (this sprint's requirement #4). `(payment_attempt_id, entry_type)` is unique — the
 * mechanism that makes posting idempotent: a webhook retry/duplicate event that reaches
 * `LedgerService` a second time finds the existing row and does not post again (requirement #5,
 * #12). Rows are never updated or deleted after insert (requirement #3) — a correction is always a
 * new row with a different `entry_type` (e.g. `refund`, `reversal`, `admin_adjustment`).
 */
export const ledgerJournalEntry = pgTable(
  "ledger_journal_entry",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    entryType: ledgerEntryTypeEnum("entry_type").notNull(),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => agreement.id),
    paymentAttemptId: uuid("payment_attempt_id")
      .notNull()
      .references(() => paymentAttempt.id),
    currency: text("currency").notNull(),
    // Required for admin_adjustment (enforced in ledgerService.ts, not the DB) — optional/null for
    // every automatic posting, which is self-explanatory from entry_type + linkage alone.
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("ledger_journal_entry_payment_type_unique").on(table.paymentAttemptId, table.entryType)],
).enableRLS();

/**
 * The individual debit/credit legs of a journal entry. `LedgerService` always inserts a journal
 * entry's postings in the same DB transaction as the entry itself, and always validates
 * sum(debits) == sum(credits) before doing so — "balanced entries" (this sprint's ledger rule) is
 * enforced in application code, checked by a dedicated test (`assertBalanced`/"balance invariant"),
 * not by a DB constraint (Postgres has no native multi-row CHECK across sibling postings).
 */
export const ledgerPosting = pgTable("ledger_posting", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  journalEntryId: uuid("journal_entry_id")
    .notNull()
    .references(() => ledgerJournalEntry.id),
  accountId: uuid("account_id")
    .notNull()
    .references(() => ledgerAccount.id),
  // Denormalized from ledger_account.account_type at posting time, purely to avoid a join on every
  // balance/reconciliation/admin read — safe because a posting's account never changes once written
  // (append-only) and an account's own account_type never changes after creation either.
  accountType: ledgerAccountTypeEnum("account_type").notNull(),
  direction: ledgerPostingDirectionEnum("direction").notNull(),
  amountMinorUnits: integer("amount_minor_units").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * Sprint 10 reconciliation exceptions — explicit, persisted records of a detected mismatch
 * (requirement #9: "must not silently ignore mismatches"). `payment_attempt_id` is nullable because
 * some exception types (`provider_event_without_internal_state`) are detected from an orphaned
 * webhook event with no matching payment at all. Reconciliation re-runs are idempotent at the
 * application level (`ReconciliationService` looks for an existing `open` row with the same
 * `(payment_attempt_id, exception_type)` before inserting — see reconciliationService.ts's doc
 * comment for why this is an application-level check rather than a DB partial-unique-index).
 */
export const reconciliationException = pgTable("reconciliation_exception", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  exceptionType: reconciliationExceptionTypeEnum("exception_type").notNull(),
  paymentAttemptId: uuid("payment_attempt_id").references(() => paymentAttempt.id),
  providerEventId: text("provider_event_id"),
  details: jsonb("details"),
  status: reconciliationExceptionStatusEnum("status").notNull().default("open"),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => userAccount.id),
  resolutionReason: text("resolution_reason"),
}).enableRLS();
