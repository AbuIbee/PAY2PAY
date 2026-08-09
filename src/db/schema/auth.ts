import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { mfaMethodEnum } from "./enums";
import { deviceSession, userAccount } from "./identity";

/**
 * Sprint 2 (docs/sprints/SPRINT_02_Authentication.md) auth/MFA tables. All
 * `.enableRLS()` for the same reason as every other table in this project
 * (src/db/schema/marketing.ts's doc comment): defense in depth against
 * Supabase's PostgREST auto-exposure, even though this app only ever reaches
 * these tables server-side through src/db/client.ts.
 */

/**
 * Single-use, time-limited tokens for email verification. Only the SHA-256
 * hash is stored (mirrors device_session.sessionTokenHash) — the raw token
 * exists only in the emailed link and is never persisted.
 */
export const emailVerificationToken = pgTable("email_verification_token", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => userAccount.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}).enableRLS();

/** Single-use, time-limited tokens for password reset. Same storage pattern as above. */
export const passwordResetToken = pgTable("password_reset_token", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => userAccount.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}).enableRLS();

/**
 * An enrolled MFA method for a user. `secretRef` holds the TOTP shared
 * secret (base32) for method="totp"; `phoneRef` holds the phone number for
 * method="sms". `verifiedAt` is null until the user proves control of the
 * method during enrollment (e.g. entering one correct TOTP code) — an
 * unverified row is never usable for a step-up challenge.
 *
 * SECURITY GAP, flagged deliberately rather than silently accepted: `secretRef`
 * is stored as plain text. This project has no field-level encryption/KMS
 * infrastructure yet (the same is already true of business_profile.einOrSsnRef
 * and personal_profile's other "ref" fields — this follows that existing,
 * already-accepted Phase 0 convention rather than inventing a new one
 * unreviewed). This must be addressed (application-level envelope encryption
 * or a secrets-manager-backed reference) before any production credential
 * relies on it — tracked as an open item in docs/AUTHENTICATION.md.
 */
export const mfaCredential = pgTable("mfa_credential", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => userAccount.id),
  method: mfaMethodEnum("method").notNull(),
  secretRef: text("secret_ref"), // TOTP shared secret (base32); see security-gap note above
  phoneRef: text("phone_ref"), // E.164 phone number for method = 'sms'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
}).enableRLS();

/**
 * A single MFA verification attempt — both enrollment-confirmation
 * challenges and step-up challenges for an already-enrolled method. For
 * method="sms" `codeHash` stores the SHA-256 of the one-time code texted to
 * the user; TOTP verification is stateless (computed against the current
 * time window from mfa_credential.secretRef) so `codeHash` is null for TOTP
 * rows — this row exists for TOTP mainly to rate-limit/audit attempts.
 */
export const mfaChallenge = pgTable("mfa_challenge", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => userAccount.id),
  method: mfaMethodEnum("method").notNull(),
  codeHash: text("code_hash"),
  purpose: text("purpose").notNull(), // 'enrollment' | 'step_up'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
}).enableRLS();

/**
 * Records that a specific session recently completed an MFA challenge, so
 * `requireStepUp` can grant a short freshness window instead of demanding a
 * fresh MFA challenge before every single sensitive action
 * (docs/sprints/SPRINT_02_Authentication.md: "a completed challenge is valid
 * for a short, configurable window, not indefinitely"). Scoped to the
 * session, not just the user, so a stale step-up on one device can't
 * authorize a sensitive action from a different, unverified session.
 */
export const stepUpVerification = pgTable("step_up_verification", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => deviceSession.id),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}).enableRLS();
