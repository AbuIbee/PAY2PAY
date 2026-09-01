import { sql } from "drizzle-orm";
import {
  boolean,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accountClassificationEnum, businessProfileStatusEnum, platformRoleEnum } from "./enums";

/**
 * Phase 0 identity/profile tables only — the exact set
 * docs/IMPLEMENTATION_PLAN.md's Phase 0 requires (user_account,
 * personal_profile, business_profile, beneficial_owner,
 * business_staff_member, custom_role). No agreement, payment, or
 * verification-provider tables are defined here; those arrive in their own
 * phases. Field-level source: docs/DATA_MODEL.md §4.
 */

export const userAccount = pgTable("user_account", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  // Normalization (lowercasing) is the caller's responsibility before
  // insert/lookup; Phase 0 uses a plain unique constraint rather than the
  // Postgres `citext` extension to avoid depending on an extension whose
  // availability hasn't been confirmed for the eventual hosting platform.
  email: text("email").notNull().unique(),
  phone: text("phone").unique(),
  // Reference to a passkey/password credential record, never the secret itself.
  authCredentialRef: text("auth_credential_ref").notNull(),
  // ISO date string. Originally scoped (Phase 0) to be captured only at Full
  // verification (FR-IDV-003); Sprint 2 (docs/sprints/SPRINT_02_Authentication.md)
  // now requires 18+ age-gating at signup itself, so this is captured then —
  // Full verification later reuses/confirms the same field rather than
  // introducing a second date-of-birth column.
  dateOfBirth: text("date_of_birth"),
  status: text("status").notNull().default("active"), // active | suspended | closed
  // Section K (closed-beta remediation, Product Owner review): a short, user-facing identifier
  // (format "P2P-XXXXXXXX") for support conversations and admin search, so a user is never asked to
  // read out their raw internal UUID. Nullable/additive rather than backfilled in this migration —
  // every new signup gets one immediately (AuthService.signup); any pre-existing row without one gets
  // it lazily, generated and persisted the first time it's actually read (see
  // UserAccountRepository.ensurePublicReference), avoiding a blocking data migration against a live
  // table. Non-sequential and non-enumerable by construction (random from a fixed alphabet, not a
  // counter), and excludes visually ambiguous characters (0/O/1/I).
  publicReference: text("public_reference").unique(),
  // Sprint 6A (docs/sprints/SPRINT_06A_Platform_Administration_Audit_Control.md): trusted,
  // server/DB-sourced platform authorization — never derived from client state. Defaults "member"
  // so every existing and future ordinary signup is unaffected.
  platformRole: platformRoleEnum("platform_role").notNull().default("member"),
  // Sprint 6A: durable classification, independent of `status` and of any naming convention.
  accountClassification: accountClassificationEnum("account_classification").notNull().default("production"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  country: text("country").notNull().default("US"), // reserved per master spec Section 1
  locale: text("locale").notNull().default("en-US"),
  timezone: text("timezone").notNull().default("America/New_York"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const personalProfile = pgTable("personal_profile", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  // One personal profile per login (FR-PROF-001).
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => userAccount.id),
  // Kept, never removed (Decision 4 — canonical connection/profile remediation): pre-existing
  // callers (DrizzleProfileDisplayReader's fallback chain) still read this. New code should prefer
  // firstName + lastName; legalName remains available as a formal/legal name distinct from the
  // casual display name, and as the display-name fallback for any profile not yet completed below.
  legalName: text("legal_name"),
  // Decision 4: split first/last name — the actual gap `legal_name` (a single combined string) never
  // filled. This is personal information (never described as non-PII anywhere in this codebase).
  firstName: text("first_name"),
  lastName: text("last_name"),
  // Decision 5/6: the agreement-facing, counterparty-visible contact email — deliberately distinct
  // from `user_account.email` (the authentication/login email), per Decision 6's own rule: changing
  // one must never change the other. Defaults to the auth email (copied in at profile-completion
  // time, never a live join) and is treated as already-verified only while it still equals the
  // user's own verified auth email — see `preferred_email_verified_at` below and
  // PersonalProfileService's own doc comment for the exact rule.
  preferredEmail: text("preferred_email"),
  // Decision 6: null until preferred_email is either (a) confirmed equal to the already-verified
  // auth email, or (b) independently verified via its own token flow. Never fabricated — see
  // PersonalProfileService.
  preferredEmailVerifiedAt: timestamp("preferred_email_verified_at", { withTimezone: true }),
  // Decision 3/4/5: contact phone number, distinct from `user_account.phone` (that column remains
  // scoped to authentication/SMS-MFA — see auth.ts's own doc comment on it — and is never read or
  // written by the personal-profile contact-information feature).
  contactPhone: text("contact_phone"),
  residentialAddress: jsonb("residential_address"),
  // Sprint 3 (docs/sprints/SPRINT_03_Personal_Business_Profiles.md): the
  // Phase 0 `verification_tier` text column is removed in favor of the
  // identity_verification_record architecture (src/db/schema/verification.ts)
  // — "basic" is derived from user_account.email_verified_at, "full" is
  // derived from the latest verified identity_verification_record. See
  // src/lib/profiles/verificationService.ts. No verification column lives
  // here, so there is no stored field a caller could self-report into
  // "verified" — see that service's doc comment for why that matters.
  currency: text("currency").notNull().default("USD"), // reserved per master spec Section 1
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Decision 4: this table becomes user-editable for the first time — every prior column was
  // write-once at signup. Added alongside the new editable columns, matching every other mutable
  // table in this schema's own established `updated_at` convention.
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const businessProfile = pgTable(
  "business_profile",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Multiple business profiles per login are allowed (FR-PROF-001).
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => userAccount.id),
    legalBusinessName: text("legal_business_name").notNull(),
    // Sprint 3: display name is distinct from the legal name (shown to
    // counterparties/UI) — required field per this sprint's field list.
    displayName: text("display_name").notNull(),
    entityType: text("entity_type").notNull(),
    einOrSsnRef: text("ein_or_ssn_ref"), // tokenized/encrypted reference, never raw
    businessAddress: jsonb("business_address"),
    country: text("country").notNull().default("US"), // reserved per master spec Section 1
    state: text("state").notNull(),
    // Sprint 3: lifecycle status — a disabled/deleted business must never be
    // selectable via the profile switcher (see profileAccessService.ts).
    status: businessProfileStatusEnum("status").notNull().default("active"),
    // See personal_profile's comment above — verification status is not a
    // stored column here either; it's derived via
    // src/lib/profiles/verificationService.ts.
    currency: text("currency").notNull().default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Soft uniqueness guard (not a legal EIN constraint) — see docs/DATA_MODEL.md §4.
    uniqueIndex("business_profile_owner_name_unique").on(
      table.ownerUserId,
      table.legalBusinessName,
    ),
  ],
).enableRLS();

export const customRole = pgTable("custom_role", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  businessProfileId: uuid("business_profile_id")
    .notNull()
    .references(() => businessProfile.id),
  name: text("name").notNull(),
  // Granular permission flags/caps per FR-STAFF-002; open decision #8 covers
  // ceiling-enforcement semantics not yet finalized (docs/OPEN_DECISIONS.md).
  permissions: jsonb("permissions").notNull(),
}).enableRLS();

export const businessStaffMember = pgTable(
  "business_staff_member",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    businessProfileId: uuid("business_profile_id")
      .notNull()
      .references(() => businessProfile.id),
    // Individual login, never shared (FR-STAFF-001).
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccount.id),
    role: text("role").notNull(), // owner | manager | receivables_staff | accountant_viewer | custom
    customRoleId: uuid("custom_role_id").references(() => customRole.id),
    // B2B: verified authority to create/negotiate/approve/sign/amend/settle/
    // manage an agreement on the business's behalf (FR-B2B-002).
    isAuthorizedRepresentative: boolean("is_authorized_representative")
      .notNull()
      .default(false),
    // Non-destructive removal (FR-STAFF-005); NULL = active.
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // PRSprint 03 (docs/prsprints/PRSPRINT_03_DATABASE_INTEGRITY_STATE_MACHINES.md) fix: the
    // original constraint here was a full (non-partial) unique index on (business_profile_id,
    // user_id), with no exception for a soft-removed row (removed_at IS NOT NULL). Since removal is
    // non-destructive (the comment above, FR-STAFF-005) and staffService.ts's `acceptInvitation`
    // always INSERTs a new row rather than reviving the old one, that full-table constraint made it
    // impossible to ever re-invite a former staff member back to the same business — the second
    // acceptance would hit a live unique-constraint violation. This partial index (matching this
    // schema's own established "active-only" pattern — see admin_role_assignment_active_user_unique,
    // admin_restriction_active_target_unique, relationship_financial_account_active_slot_unique)
    // keeps the real invariant this table needs (at most one *active* membership per business+user,
    // which staffService.ts's own findActiveByBusinessAndUser guard depends on) while allowing a
    // business to re-hire a former staff member.
    uniqueIndex("business_staff_member_active_business_user_unique")
      .on(table.businessProfileId, table.userId)
      .where(sql`${table.removedAt} IS NULL`),
  ],
).enableRLS();

/**
 * Backs basic auth (docs/IMPLEMENTATION_PLAN.md Phase 0 "basic auth
 * (password/passkey)" feature; NFR-SEC-006 secure session management). Named
 * in docs/DATA_MODEL.md §1's Identity & profiles entity list but not given a
 * full illustrative schema there — this is the minimal shape needed to
 * support login/logout/revocation. `sessionTokenHash` stores a SHA-256 hash
 * of the session token, never the raw token, so a database read alone can't
 * be replayed as a valid session (mirrors the audit hash-chain's
 * store-a-derivative-not-the-secret pattern in src/lib/audit/hash.ts).
 */
export const deviceSession = pgTable("device_session", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => userAccount.id),
  sessionTokenHash: text("session_token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Non-destructive revocation (logout, suspected compromise); NULL = active.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
}).enableRLS();

export const beneficialOwner = pgTable("beneficial_owner", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  businessProfileId: uuid("business_profile_id")
    .notNull()
    .references(() => businessProfile.id),
  legalName: text("legal_name").notNull(),
  ownershipPercent: numeric("ownership_percent", { precision: 5, scale: 2 }),
  // identity_verification_record_id intentionally omitted here: that table
  // is a Phase 2 concern (docs/IMPLEMENTATION_PLAN.md) and adding the FK now
  // would require building a later phase's table ahead of schedule.
}).enableRLS();
