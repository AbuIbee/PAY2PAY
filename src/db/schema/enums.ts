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
