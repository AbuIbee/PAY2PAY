import { sql } from "drizzle-orm";
import { date, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agreement, installmentScheduleItem } from "./agreement";
import { paymentAttempt } from "./payment";
import { agreementPartyRoleEnum, partialPaymentRequestStatusEnum, profileKindEnum } from "./enums";

/**
 * Sprint 15 (docs/sprints/SPRINT_15_ PartialPayments_Settlement.md): master spec §11's partial
 * payment request. Master spec §11 restricts who may propose/decide ("the borrower submits... the
 * creditor may accept, reject, or counteroffer") more narrowly than Sprint 14's amendment (either
 * party may propose) — `proposingPartyRole` still exists (rather than hardcoding "debtor") so a
 * creditor counteroffer can flip it, mirroring `amendment.proposing_party_role`'s exact counter
 * mechanic; `AmendmentService`'s own precedent of collapsing a request/response negotiation and its
 * resulting effect into one table is followed here too — this is deliberately simpler than
 * `docs/DATA_MODEL.md` §4's illustrative shape only in that it also carries the outcome fields
 * (`payment_attempt_id`, `applied_at`, `expired_at`) rather than requiring a second join.
 *
 * "Acceptance of a partial payment must not automatically constitute full settlement" (master spec
 * §11) is enforced by construction: nothing in `PartialPaymentService` ever writes to
 * `agreement.status` or creates an `agreement_version` — the remaining balance's disposition is
 * only ever `remainder_treatment`'s free-text record until/unless a *separate* Settlement covers it.
 */
export const partialPaymentRequest = pgTable("partial_payment_request", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agreementId: uuid("agreement_id")
    .notNull()
    .references(() => agreement.id),
  installmentScheduleItemId: uuid("installment_schedule_item_id").references(() => installmentScheduleItem.id),
  status: partialPaymentRequestStatusEnum("status").notNull().default("proposed"),
  // Whichever party currently holds the ball — see amendment.ts's identical field for the exact
  // same counter-offer semantics.
  proposingPartyRole: agreementPartyRoleEnum("proposing_party_role").notNull(),
  proposedByProfileKind: profileKindEnum("proposed_by_profile_kind").notNull(),
  proposedByProfileId: uuid("proposed_by_profile_id").notNull(),
  proposedAmountMinorUnits: integer("proposed_amount_minor_units").notNull(),
  proposedDate: date("proposed_date").notNull(),
  explanation: text("explanation"),
  remainderTreatment: text("remainder_treatment"),
  rejectedReason: text("rejected_reason"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  // Set once, when a succeeded payment_attempt is linked in — see PartialPaymentService.recordPayment.
  paymentAttemptId: uuid("payment_attempt_id").references(() => paymentAttempt.id),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
