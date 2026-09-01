import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { personalProfile } from "./identity";

/**
 * Decision 6 (preferred contact email): a small, dedicated verification-token table for
 * `personal_profile.preferred_email` — deliberately NOT the existing `email_verification_token`
 * table (that one is hard-scoped to `user_account.email`, the authentication email, and its own
 * `AuthService.verifyEmail` always marks the AUTH email verified; reusing it here would risk
 * conflating the two, which Decision 6 explicitly forbids: "Do NOT modify the user's authentication
 * email as part of this feature"). Reuses the same `generateOpaqueToken`/`hashOpaqueToken` primitive
 * (Sprint 2) — no second token *scheme* invented, only a second, narrowly-scoped table for a
 * genuinely different verification target.
 */
export const preferredEmailVerificationToken = pgTable("preferred_email_verification_token", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  personalProfileId: uuid("personal_profile_id")
    .notNull()
    .references(() => personalProfile.id),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
