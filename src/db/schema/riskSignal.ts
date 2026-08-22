import { sql } from "drizzle-orm";
import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { userAccount } from "./identity";

/**
 * SPRINT_19_FraudRisk_SecurityHardening §12: an internal fraud/risk signal model capable of
 * recording signals without automatically accusing a user of fraud — grepped the whole codebase
 * before writing this; nothing named risk_event/fraud_signal/RiskEvent existed anywhere. Append-only
 * (same "immutable historical artifact" discipline as `audit_event`/`consent_record` — a later
 * review never rewrites what was actually observed, only adds a review decision on top via
 * `reviewState`/`reviewedByUserId`/`reviewedAt`).
 *
 * Deliberately minimal `detail` payload: per this sprint's own instruction ("do not collect
 * unnecessary invasive information merely because it might someday be useful"), every call site that
 * records a signal stores only small, already-derived counters/thresholds (e.g. `{count, windowMinutes}`)
 * — never a raw IP, device fingerprint, or free-text description of the user. IP/device data already
 * has its own home (`audit_event.ipAddress`/`deviceInfo`); this table is for the *pattern*, not a
 * second copy of the raw signal.
 *
 * This is a signal ledger, not an enforcement mechanism: recording a signal here never blocks an
 * action by itself (see RiskEventService's own doc comment) — matching this sprint's explicit "do not
 * automatically permanently ban accounts based on one weak signal" and the existing
 * `payment_flagged_for_review` precedent (PRSprint 33), which also only ever flags, never blocks.
 */
export const riskSignalTypeEnum = pgEnum("risk_signal_type", [
  // Repeated authentication failures beyond the normal rate-limit threshold (src/lib/rate-limit.ts
  // already blocks the request itself; this records the *pattern* for admin visibility).
  "repeated_authentication_failure",
  // A payer's payment attempts have failed repeatedly in a short window.
  "repeated_payment_failure",
  // A relationship's funding/payout bank connection has been replaced more than once in a short
  // window — the same signal docs/SECURITY_MODEL.md threat #16 (payout redirection) names.
  "frequent_bank_connection_change",
  // A large-value action taken on a recently-created account.
  "high_value_action_new_account",
  // Excessive invitation creation beyond the normal rate-limit threshold.
  "invitation_velocity",
  // A Platform Admin/Owner action worth surfacing for review (e.g. a manual ledger adjustment, a
  // kill-switch flip) — visibility, not an accusation against the admin.
  "unusual_admin_activity",
]);

export const riskSignalSeverityEnum = pgEnum("risk_signal_severity", ["info", "low", "medium", "high"]);

/** Controlled outcomes this sprint's own spec names — "allow" is implicit (no row is ever written for it). */
export const riskSignalOutcomeEnum = pgEnum("risk_signal_outcome", [
  "flagged",
  "challenge_recommended",
  "manual_review_recommended",
]);

export const riskSignalReviewStateEnum = pgEnum("risk_signal_review_state", ["open", "reviewed", "dismissed"]);

export const riskEvent = pgTable("risk_event", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => userAccount.id),
  signalType: riskSignalTypeEnum("signal_type").notNull(),
  severity: riskSignalSeverityEnum("severity").notNull(),
  outcome: riskSignalOutcomeEnum("outcome").notNull(),
  // Mirrors audit_event's targetResourceType/targetResourceId pattern — the affected
  // transaction/action, e.g. ("payment_attempt", <id>) or ("relationship_financial_account", <id>).
  relatedResourceType: text("related_resource_type"),
  relatedResourceId: text("related_resource_id"),
  // Small, already-derived counters only — see this file's own doc comment. Never a raw IP/device
  // fingerprint or free-text user description.
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewState: riskSignalReviewStateEnum("review_state").notNull().default("open"),
  reviewedByUserId: uuid("reviewed_by_user_id").references(() => userAccount.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
}).enableRLS();
