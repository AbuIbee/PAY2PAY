import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { userAccount } from "./identity";

/**
 * B0-B (SMS consent / A2P compliance): the durable, auditable record of a user's own affirmative
 * opt-in to transactional SMS from Paid2You, captured through Paid2You's own web-form UI. Deliberately
 * distinct from two existing, unrelated tables:
 * - `notification_preference` (Sprint 17) is a per-(notificationType, channel) delivery toggle whose
 *   absence means "enabled" — it can express "I don't want SMS for payment_failed specifically," but
 *   it cannot answer "did this user ever affirmatively consent to receive SMS from Paid2You at all,
 *   and when, and under what disclosure, and to which destination."
 * - `sms_opt_out` (PRSprint 15) is a phone-keyed carrier STOP suppression, independent of any user
 *   account — it can prove someone doesn't want SMS, never that someone affirmatively opted in.
 *
 * One row per user, upserted on every activate/withdraw (mirrors `notification_preference`'s own
 * established simple-upsert convention, rather than a heavier append-only ledger) — the full history
 * of every past activate/withdraw transition additionally lives in `audit_event`
 * (`sms_consent_activated`/`sms_consent_withdrawn` — see NotificationService's own doc comments), so
 * this table only needs to hold the CURRENT state plus the most recent transition timestamps, not a
 * complete ledger of its own.
 *
 * Codex B0-B blocker correction (B0-B-001): the original shape of this table carried no phone
 * association at all, so a user's affirmative consent to receive SMS at phone A silently kept
 * authorizing delivery after they replaced their verified phone with B — no fresh affirmative act ever
 * covered B. `consentedPhoneE164` closes this: it is the exact, normalized, verified phone the user's
 * MOST RECENT affirmative activation actually covered. `NotificationService` never treats a row as
 * effectively active unless the CURRENT verified phone equals this column exactly (see
 * `getSmsConsentStatus`/`deliver`'s own doc comments) — a phone replacement, however it happens, makes
 * consent stop applying, with no code path required to specifically detect "a phone changed."
 */
export const smsConsent = pgTable(
  "sms_consent",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccount.id),
    // Current state only. Always combined with `sms_opt_out` (phone-keyed STOP) AND, as of the B0-B-001
    // correction, with live destination equality at read/delivery time — see
    // NotificationService.getSmsConsentStatus/deliver's own doc comments. This column is never silently
    // flipped by the inbound STOP webhook itself (that webhook is phone-keyed, this table is
    // user-keyed, mirroring exactly why `sms_opt_out` itself is phone-keyed rather than user-keyed).
    active: boolean("active").notNull().default(false),
    // B0-B-001: the exact, normalized (E.164) verified phone the most recent affirmative activation
    // covered — never a raw/unverified/user-entered number (activation requires an already-verified
    // MFA phone; see NotificationService.activateSmsConsent). Nullable only for the legacy/no-consent
    // state (no row, or a row that has never been activated); an activation written through the
    // service always populates it (enforced by the CHECK constraint below, and by
    // NotificationService.activateSmsConsent's own precondition). Preserved (not cleared) on
    // withdrawal — it remains the historical record of which destination the withdrawn consent last
    // covered, for audit purposes; only a fresh `active=true` activation ever overwrites it.
    consentedPhoneE164: text("consented_phone_e164"),
    // Most recent affirmative opt-in — re-set (not preserved) on every re-activation after a prior
    // withdrawal. The full history of every past transition lives in `audit_event`, not here.
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    // Closed vocabulary in practice ("web_form" is the only value this pass ever writes) but kept as
    // free text, matching `sms_opt_out.source`'s own identical precedent, rather than a DB enum for a
    // single-value set that may grow later (e.g. an admin-assisted flow).
    source: text("source"),
    // Identifies exactly which disclosure copy the user consented to (see
    // src/lib/notify/smsConsentDisclosure.ts) — required to answer "what disclosure they consented
    // to" if the wording is ever revised later without retroactively reinterpreting old consent.
    disclosureVersion: text("disclosure_version"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sms_consent_user_id_unique").on(table.userId),
    // B0-B-001: a row the application itself ever wrote as `active = true` must always carry the
    // destination it covers — this is the database-level backstop for
    // NotificationService.activateSmsConsent's own precondition (never persists active=true without a
    // verified phone), so a future code path cannot accidentally reintroduce phone-less "active"
    // consent even if it forgets this check.
    check("sms_consent_active_requires_phone", sql`${table.active} = false OR ${table.consentedPhoneE164} IS NOT NULL`),
  ],
).enableRLS();
