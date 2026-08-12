import { sql } from "drizzle-orm";
import { date, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreement, installmentScheduleItem } from "./agreement";
import { paymentRetryStatusEnum, profileKindEnum, rescheduleRequestStatusEnum } from "./enums";
import { paymentAttempt } from "./payment";
import { userAccount } from "./identity";

/**
 * Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md): tracks the single automatic
 * retry scheduled for a failed payment attempt. Deliberately a separate table from `payment_attempt`
 * rather than an `attempt_kind` column on it (the illustrative shape in docs/DATA_MODEL.md §4) — the
 * retry's own resulting charge is still an ordinary `payment_attempt` row (created through the exact
 * same `AchPaymentService`/`DebitCardPaymentService.createManualPayment` gate any manual payment
 * uses), so no new payment-attempt-level "kind" concept was needed; this table's own existence is
 * what "was this a retry" means, via `resulting_payment_attempt_id`.
 * `original_payment_attempt_id` unique — a DB-level backstop for "never implement uncontrolled
 * retries" alongside `PaymentRetryService`'s own application-level check.
 */
export const paymentRetry = pgTable(
  "payment_retry",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    originalPaymentAttemptId: uuid("original_payment_attempt_id")
      .notNull()
      .references(() => paymentAttempt.id),
    installmentScheduleItemId: uuid("installment_schedule_item_id")
      .notNull()
      .references(() => installmentScheduleItem.id),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => agreement.id),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: paymentRetryStatusEnum("status").notNull().default("scheduled"),
    resultingPaymentAttemptId: uuid("resulting_payment_attempt_id").references(() => paymentAttempt.id),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    canceledReason: text("canceled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("payment_retry_original_payment_attempt_unique").on(table.originalPaymentAttemptId)],
).enableRLS();

/**
 * Sprint 13: a borrower's request to move a specific installment's due date, and the creditor's
 * (or authorized business staff's) decision on it. `current_due_date` is a snapshot taken at request
 * time — not read live from `installment_schedule_item` — so a later, unrelated due-date change
 * can't retroactively change what this historical request appears to have been asking for.
 * Append-only, matching every other table in this schema: a decision is recorded on this same row
 * (never deleted), and approval writes the new date to `installment_schedule_item.due_date`
 * separately, through `InstallmentRescheduleRepository.updateDueDate` — this row itself is the
 * durable record of *why* that field changed (this sprint's "preserve original installment record").
 */
export const rescheduleRequest = pgTable("reschedule_request", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  installmentScheduleItemId: uuid("installment_schedule_item_id")
    .notNull()
    .references(() => installmentScheduleItem.id),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreement.id),
  requestedByProfileKind: profileKindEnum("requested_by_profile_kind").notNull(),
  requestedByProfileId: uuid("requested_by_profile_id").notNull(),
  currentDueDate: date("current_due_date").notNull(),
  requestedDueDate: date("requested_due_date").notNull(),
  reason: text("reason"),
  status: rescheduleRequestStatusEnum("status").notNull().default("pending"),
  decidedByUserId: uuid("decided_by_user_id").references(() => userAccount.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionReason: text("decision_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * Sprint 13: minimal internal notification-event ledger — see enums.ts's doc comment on why
 * `notification_type` is free text. `recipient_user_id` (not a profile ref) since every recipient of
 * a payment-workflow notification is always resolved from a `payment_attempt`'s payer/recipient
 * profile back to that profile's owning user (`ProfileOwnerReader`, the same resolution every other
 * authorization check in this codebase already uses), matching how a user actually receives a
 * notification (their account), not a profile abstraction.
 */
export const notificationEvent = pgTable("notification_event", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  recipientUserId: uuid("recipient_user_id")
    .notNull()
    .references(() => userAccount.id),
  notificationType: text("notification_type").notNull(),
  relatedPaymentAttemptId: uuid("related_payment_attempt_id").references(() => paymentAttempt.id),
  relatedAgreementId: uuid("related_agreement_id").references(() => agreement.id),
  payload: jsonb("payload").notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
