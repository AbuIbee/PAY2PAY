import { sql } from "drizzle-orm";
import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { userAccount } from "./identity";

/**
 * PRSprint 32 (docs/prsprints/PRSPRINT_32_COMPLIANCE_HOOKS_CONSENT_PRIVACY_RETENTION.md): master-spec
 * items 99-100 — "versioned Terms/Privacy/e-sign/e-communications/SMS/provider/card/banking consent
 * hooks" and "store consent version/actor/time/method." One generic, append-only record per consent
 * event — never updated or deleted (the same "immutable historical artifact" discipline as
 * `retention_hold`/`audit_event`), so a later policy-version change can never retroactively alter what
 * a user actually agreed to.
 *
 * Deliberately does not define the *content* of any policy — this table stores which version a user
 * consented to and when, not the policy text itself (that remains counsel-reviewed content published
 * elsewhere, e.g. the `/terms`/`/privacy` marketing pages). Signing-specific consent
 * (`consentCaptured`/`consentVersion` on the signature-evidence path, PRSprint 12) already existed
 * before this table and is intentionally left as-is, not migrated here — this table is for the
 * account-level consents (ToS, Privacy, e-communications, SMS) that had no capture mechanism at all.
 */
export const consentPolicyTypeEnum = pgEnum("consent_policy_type", [
  "terms_of_service",
  "privacy_policy",
  "electronic_communications_consent",
  "sms_consent",
]);

export const consentRecord = pgTable("consent_record", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => userAccount.id),
  policyType: consentPolicyTypeEnum("policy_type").notNull(),
  // Free text, not an enum — the actual version identifiers (e.g. "2026-08-19", "v1") are set by
  // whoever publishes the reviewed policy, not fixed by this schema ahead of time.
  policyVersion: text("policy_version").notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
  // e.g. "signup_checkbox", "account_settings", "api" — how consent was captured, not a closed enum
  // for the same reason target_resource_type elsewhere in this codebase is free text.
  method: text("method").notNull(),
  ipAddress: text("ip_address"),
}).enableRLS();

/**
 * PRSprint 33 (docs/prsprints/PRSPRINT_33_FINAL_PRODUCTION_LAUNCH_CONTROLS_CLOSED_BETA.md): master-
 * spec items 153/199, "financial launch should be phased... use a small controlled cohort." A single-
 * use invite code, consumed atomically at signup (`WHERE used_by_user_id IS NULL` — the same
 * claim-before-side-effect discipline PRSprint 31 established for invitation accept/cancel races; two
 * people racing to redeem the same code must never both succeed). Only enforced when the
 * `closedBetaEnabled` feature flag is on (default false) — see BetaInviteService's own doc comment for
 * why the gate lives at the API-route layer, not inside AuthService.signup itself.
 */
export const betaInviteCode = pgTable("beta_invite_code", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => userAccount.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  note: text("note"),
  usedByUserId: uuid("used_by_user_id").references(() => userAccount.id),
  usedAt: timestamp("used_at", { withTimezone: true }),
}).enableRLS();
