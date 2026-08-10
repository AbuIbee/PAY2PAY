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

/**
 * Sprint 5 (docs/sprints/SPRINT_05_Agreement_Engine.md): the agreement lifecycle, using the
 * sprint's own DEBTOR/CREDITOR terminology (lowercased to match this project's enum-value
 * convention) rather than docs/STATE_MACHINES.md §1's payer/recipient naming — same states, same
 * transition graph, just the sprint's literal vocabulary since "creditor"/"debtor" are also this
 * sprint's required field names.
 */
export const agreementStatusEnum = pgEnum("agreement_status", [
  "draft",
  "awaiting_debtor_acknowledgment",
  "awaiting_creditor_acceptance",
  "awaiting_signatures",
  "signed",
  "first_payment_pending",
  "active",
  "past_due",
  "disputed",
  "paused_by_amendment",
  "paid_in_full",
  "settled_in_full",
  "mutually_canceled",
  "closed",
]);

/** Sprint 5: docs/DATA_MODEL.md §4's `agreement_party.role` — "witness" is deferred to Sprint 7. */
export const agreementPartyRoleEnum = pgEnum("agreement_party_role", ["creditor", "debtor"]);

/** Sprint 5: master spec §5's recurring-installment cadence. */
export const paymentFrequencyEnum = pgEnum("payment_frequency", ["weekly", "biweekly", "monthly"]);

/** Sprint 5: master spec §4/FR-PAYMETHOD-003 — who pays processing fees. */
export const feeAllocationEnum = pgEnum("fee_allocation", [
  "creditor_pays",
  "debtor_pays",
  "split_evenly",
]);

/** Sprint 5: docs/DATA_MODEL.md §4's `installment_schedule_item.status`. */
export const installmentItemStatusEnum = pgEnum("installment_item_status", [
  "scheduled",
  "paid",
  "past_due",
  "waived",
]);

/**
 * Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md): business-signer authority
 * evidence — null on `signature_event` for a personal-profile signer, since "signing authority" is
 * a business-specific concept per this sprint's text ("signing authority where business").
 * `account_owner` covers the pre-Sprint-4-staff-row bootstrap gap (same as AgreementService's own
 * authorization — a business owner is always authorized even with no `business_staff_member` row);
 * `authorized_representative` requires `business_staff_member.is_authorized_representative = true`
 * (src/db/schema/identity.ts's FR-B2B-002 field), never mere active staff membership.
 */
export const signingAuthorityEnum = pgEnum("signing_authority", [
  "account_owner",
  "authorized_representative",
]);
