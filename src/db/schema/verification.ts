import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { profileKindEnum, verificationStatusEnum, verificationTierEnum } from "./enums";
import { userAccount } from "./identity";

/**
 * Sprint 3 (docs/sprints/SPRINT_03_Personal_Business_Profiles.md) identity
 * verification architecture. Matches docs/DATA_MODEL.md §4's illustrative
 * `identity_verification_record` shape. One row per verification *attempt*
 * (not one column per profile), so the audited history of pending/verified/
 * rejected decisions is preserved rather than overwritten — this is also
 * what makes "verification status cannot self-report as FULL_VERIFIED"
 * enforceable: there is no single mutable boolean/enum column on
 * personal_profile/business_profile for a caller to flip directly, only
 * this insert-only-per-decision table, written exclusively through
 * src/lib/profiles/verificationService.ts.
 *
 * Sprint 3 owns this architecture; Sprint 9 owns the actual KYC/KYB provider
 * integration that produces real `verified`/`rejected` decisions later
 * (`provider_ref`/`verified_fields` are reserved for that). Until then, the
 * only way to reach `verified` is verificationService.ts's explicit,
 * audited manual/mock decision path — never automatic.
 */
export const identityVerificationRecord = pgTable("identity_verification_record", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  profileKind: profileKindEnum("profile_kind").notNull(),
  profileId: uuid("profile_id").notNull(), // personal_profile.id or business_profile.id
  tier: verificationTierEnum("tier").notNull(), // always 'full' in practice — 'basic' is derived, not recorded
  status: verificationStatusEnum("status").notNull().default("pending"),
  providerRef: text("provider_ref"), // external KYC/KYB provider reference — Sprint 9
  verifiedFields: jsonb("verified_fields"), // which fields the provider/reviewer confirmed
  // Who decided (Sprint 9's real provider integration, or this sprint's
  // audited manual/mock path). Null while status = 'pending'.
  reviewerUserId: uuid("reviewer_user_id").references(() => userAccount.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionReason: text("decision_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
