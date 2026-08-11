import { sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Sprint 9 (docs/sprints/SPRINT_09_PaymentProviderAbstraction _Sandbox.md) KYC/KYB provider
 * integration — a separate abstraction from the payment-provider one above (the sprint's own text:
 * "do not merge the two interfaces"), so this gets its own webhook idempotency/replay-protection
 * table rather than sharing `payment_webhook_event`. Mirrors that table's shape exactly; kept as a
 * distinct table because a payment-provider webhook and a KYC/KYB-provider webhook are unrelated
 * external integrations that happen to need the same dedupe mechanics, not two views onto the same
 * concept.
 */
export const kycWebhookEvent = pgTable(
  "kyc_webhook_event",
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
  (table) => [uniqueIndex("kyc_webhook_event_provider_event_unique").on(table.provider, table.providerEventId)],
).enableRLS();
