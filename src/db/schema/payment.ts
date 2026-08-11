import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import { paymentAttemptStatusEnum, profileKindEnum } from "./enums";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payment_attempt_idempotency_key_unique").on(table.idempotencyKey),
    uniqueIndex("payment_attempt_provider_payment_id_unique").on(table.providerPaymentId),
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
