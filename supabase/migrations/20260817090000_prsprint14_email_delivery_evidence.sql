-- PRSprint 14 (docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md): delivery evidence for the real email
-- provider. `sent_at` records when the provider accepted the send (distinct from `delivered_at`,
-- which now means an actual provider-confirmed delivery webhook fired). `provider_message_id`
-- correlates an inbound delivery/bounce/complaint webhook back to the row it belongs to. Both
-- nullable/additive — no backfill needed, every existing row is simply untouched by either column.
ALTER TABLE "notification_event" ADD COLUMN "sent_at" timestamp with time zone;
ALTER TABLE "notification_event" ADD COLUMN "provider_message_id" text;
