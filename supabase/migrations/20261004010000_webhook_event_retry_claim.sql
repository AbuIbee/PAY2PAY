-- "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-3: adds the additive `claimed_at` column
-- both webhook-event tables need to distinguish "already successfully processed" from "was inserted
-- but never finished processing" — previously, ANY existing (provider, provider_event_id) row was
-- treated as a permanent duplicate regardless of `processed_at`, so a provider's retry of a failed
-- delivery was silently (and permanently) ignored. See
-- src/lib/organizations/drizzleBusinessVerificationWebhookEventRepository.ts's own `claimEvent` doc
-- comment for the exact atomic-claim mechanism this column enables. Nullable, no default required on
-- existing rows (NULL simply means "never (re-)claimed" — identical in meaning to every existing row's
-- current state) — preserves all existing data, nothing to lose.
ALTER TABLE "business_verification_webhook_event" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_billing_webhook_event" ADD COLUMN "claimed_at" timestamp with time zone;
