import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreement, installmentScheduleItem } from "./agreement";
import { paymentAttemptStatusEnum, paymentMethodEnum, profileKindEnum } from "./enums";

/**
 * Sprint 9 (docs/sprints/SPRINT_09_PaymentProviderAbstraction _Sandbox.md) payment-provider
 * abstraction. Deliberately narrower than docs/DATA_MODEL.md §4's illustrative `payment_attempt`
 * shape (no `payment_method_id`/`installment_schedule_item_id`/`attempt_kind` — those depend on a
 * payment-method-on-file flow and the ledger/installment linkage that don't exist until Sprint
 * 10-12) — this table exists so PaymentService has somewhere durable to enforce idempotency and
 * record provider-driven state transitions, per this sprint's "Payment records must be
 * append/audit-oriented" and "Preserve idempotency and auditability" requirements. `agreementId` is
 * nullable because this sprint's abstraction is provider/sandbox-scoped, not yet required to be
 * called only from an agreement-installment context.
 *
 * `providerPaymentId` is an external reference column only (never a join key elsewhere), per this
 * sprint's "Treat external/provider IDs as external references, not as primary internal domain
 * identifiers."
 */
export const paymentAttempt = pgTable(
  "payment_attempt",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    idempotencyKey: text("idempotency_key").notNull(),
    payerProfileKind: profileKindEnum("payer_profile_kind").notNull(),
    payerProfileId: uuid("payer_profile_id").notNull(),
    recipientProfileKind: profileKindEnum("recipient_profile_kind").notNull(),
    recipientProfileId: uuid("recipient_profile_id").notNull(),
    amountMinorUnits: integer("amount_minor_units").notNull(),
    currency: text("currency").notNull().default("USD"),
    agreementId: uuid("agreement_id").references(() => agreement.id),
    status: paymentAttemptStatusEnum("status").notNull().default("pending"),
    providerName: text("provider_name").notNull(),
    providerPaymentId: text("provider_payment_id"),
    failureReason: text("failure_reason"),
    // Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md) addition: set once, when the
    // ledger's "payout" entry posts (see ledgerService.ts) — never written any other way. Nullable;
    // null means no payout has occurred yet, regardless of payment status.
    payoutCompletedAt: timestamp("payout_completed_at", { withTimezone: true }),
    // Sprint 11 (docs/sprints/SPRINT_11_ACH_Sandbox.md) addition: set when payout is initiated,
    // before it settles — docs/PAYMENT_STATE_MACHINE.md §1's "Cleared → PayoutPending" step.
    // Payout status is derived from these two timestamps rather than a separate enum column,
    // mirroring Sprint 10's own precedent (payoutCompletedAt) rather than overloading the main
    // `status` column with a concern §2 of that doc models as its own lifecycle: null/null = not
    // yet payout-pending, set/null = PayoutPending, set/set = PaidOut.
    payoutInitiatedAt: timestamp("payout_initiated_at", { withTimezone: true }),
    // Sprint 11 addition: which installment this attempt is collecting, per
    // docs/PAYMENT_STATE_MACHINE.md §1's own opening line ("each payment_attempt row is one attempt
    // at collecting one installment") and docs/DATA_MODEL.md §4's illustrative shape. Nullable —
    // Sprint 9's abstraction-level tests and any future extra/settlement payment (Sprint 15+) have
    // no specific installment to link to.
    installmentScheduleItemId: uuid("installment_schedule_item_id").references(() => installmentScheduleItem.id),
    // Sprint 12 (docs/sprints/SPRINT_12_DebitCard_Sandbox.md) addition: which rail this attempt
    // used. Nullable — every pre-Sprint-12 row never set this. See enums.ts's paymentMethodEnum doc
    // comment for why this exists as its own column rather than being inferred from status values.
    paymentMethod: paymentMethodEnum("payment_method"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payment_attempt_idempotency_key_unique").on(table.idempotencyKey),
    uniqueIndex("payment_attempt_provider_payment_id_unique").on(table.providerPaymentId),
    // PRSprint 03 (docs/prsprints/PRSPRINT_03_DATABASE_INTEGRITY_STATE_MACHINES.md): a payment
    // attempt of zero or negative amount has no valid business meaning — every creation path
    // already validates this at the zod boundary (see src/lib/agreements/validation.ts's
    // `.positive()` schedule-amount checks), but nothing stopped a future bug in application code
    // from writing a bad row directly. Applied NOT VALID in the migration (not scanned against
    // existing rows here) — see that migration file's own comment for why.
    check("payment_attempt_amount_positive", sql`${table.amountMinorUnits} > 0`),
  ],
).enableRLS();

/**
 * Sprint 9 webhook idempotency/replay-protection ledger for the payment provider specifically
 * (kept separate from `kyc_webhook_event` — this sprint's text: "do not merge the two
 * interfaces," extended here to their event tables too). Every inbound webhook, valid or not,
 * that passes signature verification gets exactly one row keyed by (provider, provider_event_id);
 * a redelivered/replayed event is detected by that unique constraint before ever being reapplied.
 * `processedAt` is null until the event's business-logic effect (a payment_attempt status
 * transition) has been applied, supporting this sprint's "asynchronous processing" requirement
 * without requiring a real job queue to exist yet.
 */
export const paymentWebhookEvent = pgTable(
  "payment_webhook_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    signatureVerified: boolean("signature_verified").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("payment_webhook_event_provider_event_unique").on(table.provider, table.providerEventId)],
).enableRLS();
