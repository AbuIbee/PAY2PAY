import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Discriminates whether a profile-scoped reference points at a
 * personal_profile or a business_profile row (docs/DATA_MODEL.md §0/§3).
 */
export const profileKindEnum = pgEnum("profile_kind", ["personal", "business"]);

/**
 * Sprint 1 (docs/sprints/SPRINT_01_PublicPreview _VercelReadiness.md) early-access
 * lead form's "individual/business" field.
 */
export const earlyAccessAccountTypeEnum = pgEnum("early_access_account_type", [
  "individual",
  "business",
]);

/**
 * Sprint 2 (docs/sprints/SPRINT_02_Authentication.md) MFA/step-up methods.
 * "passkey" is reserved but not yet implemented — see docs/AUTHENTICATION.md
 * for why passkey (WebAuthn) enrollment was deliberately deferred out of
 * this sprint rather than rushed.
 */
export const mfaMethodEnum = pgEnum("mfa_method", ["totp", "sms", "passkey"]);

/**
 * Sprint 3 (docs/sprints/SPRINT_03_Personal_Business_Profiles.md) identity
 * verification architecture — matches docs/DATA_MODEL.md §4's illustrative
 * `identity_verification_record.tier`/`.status`. "basic" tier itself has no
 * record (it's derived from Sprint 2's `user_account.email_verified_at` —
 * see verificationService.ts); records only exist for "full" tier attempts.
 */
export const verificationTierEnum = pgEnum("verification_tier", ["basic", "full"]);
export const verificationStatusEnum = pgEnum("verification_status", [
  "pending",
  "verified",
  "rejected",
]);

/** Sprint 3: business_profile lifecycle — a disabled/deleted business cannot be selected. */
export const businessProfileStatusEnum = pgEnum("business_profile_status", [
  "active",
  "disabled",
  "deleted",
]);

/** Sprint 3 (master spec §19): personal vs. business pricing catalogs are distinct. */
export const pricingPlanKindEnum = pgEnum("pricing_plan_kind", ["personal", "business"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", ["active", "canceled"]);

/**
 * Sprint 4 (docs/sprints/SPRINT_04_BusinessStaff_Permissions.md) — matches
 * docs/DATA_MODEL.md §4's illustrative `staff_approval_request.status`.
 */
export const approvalRequestStatusEnum = pgEnum("approval_request_status", [
  "pending",
  "approved",
  "rejected",
]);

/** Sprint 4: staff invitation lifecycle — mirrors docs/DATA_MODEL.md §4's `invitation.status` shape. */
export const staffInvitationStatusEnum = pgEnum("staff_invitation_status", [
  "pending",
  "accepted",
  "expired",
  "revoked",
]);
