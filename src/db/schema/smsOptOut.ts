import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md), requirement #24: records a phone
 * number's own STOP-driven opt-out, independent of `notification_preference` (Sprint 17) — that table
 * is keyed by `user_id`, but an opt-out reply can arrive from a phone number the moment it's sent,
 * before (or without) ever being tied to any Paid2You account (an unregistered invitee's number, or a
 * number entered but not yet linked). Keyed by the E.164 phone number itself, not a user id, so a
 * suppression is enforced regardless of which (if any) account the number is later associated with.
 *
 * RLS enabled with zero policies (deny-all for anon/authenticated), matching every other table in this
 * schema (PRSprint 02's established "app connects as owner/BYPASSRLS, RLS here only blocks direct
 * anon/authenticated PostgREST access, which this table never receives" precedent) — this table is
 * only ever read/written by `NotificationService`/the Twilio inbound webhook, never queried directly
 * by a client.
 */
export const smsOptOut = pgTable("sms_opt_out", {
  phone: text("phone").primaryKey(), // E.164
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }).notNull().defaultNow(),
  // "stop_keyword" (an inbound STOP/STOPALL/UNSUBSCRIBE/etc. reply) or "provider_rejection" (Twilio
  // error 21610 — the provider already knows the number is unsubscribed) — never anything else, so
  // this stays a small closed vocabulary rather than free text.
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
