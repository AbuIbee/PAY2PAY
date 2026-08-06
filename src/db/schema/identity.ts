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
  dateOfBirth: text("date_of_birth"), // ISO date string; captured at Full verification (FR-IDV-003)
  status: text("status").notNull().default("active"), // active | suspended | closed
  country: text("country").notNull().default("US"), // reserved per master spec Section 1
  locale: text("locale").notNull().default("en-US"),
  timezone: text("timezone").notNull().default("America/New_York"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const personalProfile = pgTable("personal_profile", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  // One personal profile per login (FR-PROF-001).
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => userAccount.id),
  legalName: text("legal_name"),
  residentialAddress: jsonb("residential_address"),
  verificationTier: text("verification_tier").notNull().default("none"), // none | basic | full
  currency: text("currency").notNull().default("USD"), // reserved per master spec Section 1
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const businessProfile = pgTable(
  "business_profile",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Multiple business profiles per login are allowed (FR-PROF-001).
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => userAccount.id),
    legalBusinessName: text("legal_business_name").notNull(),
    entityType: text("entity_type").notNull(),
    einOrSsnRef: text("ein_or_ssn_ref"), // tokenized/encrypted reference, never raw
    businessAddress: jsonb("business_address"),
    verificationTier: text("verification_tier").notNull().default("none"),
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
);

export const customRole = pgTable("custom_role", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  businessProfileId: uuid("business_profile_id")
    .notNull()
    .references(() => businessProfile.id),
  name: text("name").notNull(),
  // Granular permission flags/caps per FR-STAFF-002; open decision #8 covers
  // ceiling-enforcement semantics not yet finalized (docs/OPEN_DECISIONS.md).
  permissions: jsonb("permissions").notNull(),
});

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
    uniqueIndex("business_staff_member_business_user_unique").on(
      table.businessProfileId,
      table.userId,
    ),
  ],
);

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
});

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
});
