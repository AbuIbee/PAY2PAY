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

/**
 * Sprint 6A (docs/sprints/SPRINT_06A_Platform_Administration_Audit_Control.md): platform-wide
 * administrative authority, entirely separate from `agreement_party_role`/business-staff
 * `capabilities` (Sprint 4) — this governs the internal admin console, never a party's rights
 * within any specific agreement. Trusted only from this DB column, never from client-supplied
 * state (the sprint's explicit "No client application may determine its own trusted role").
 */
export const platformRoleEnum = pgEnum("platform_role", ["member", "platform_admin", "platform_owner"]);

/**
 * Sprint 6A: durable test/internal-account classification, independent of `user_account.status`
 * (active/suspended/closed — an operational lifecycle) and of any naming convention. "production" is
 * the default and the only classification real customers should ever have.
 */
export const accountClassificationEnum = pgEnum("account_classification", [
  "production",
  "internal",
  "qa",
  "demo",
  "automated_test",
]);

/**
 * Sprint 7 (docs/sprints/SPRINT_07_Evidence_Documents_Witnesses.md): the sprint's own required
 * evidence-category list. Deliberately excludes any identity/banking category — "Sensitive identity
 * and banking records must not use ordinary agreement evidence access," so this table (and this
 * enum) simply has no vocabulary for them; those remain Sprint 3's Verification Service's own
 * restricted path (docs/ARCHITECTURE.md's document-flow diagram already separates the two).
 */
export const evidenceDocumentTypeEnum = pgEnum("evidence_document_type", [
  "invoice",
  "receipt",
  "contract",
  "estimate",
  "purchase_order",
  "proof_of_delivery",
  "proof_of_completed_work",
  "prior_payment_record",
  "other",
]);

/**
 * Sprint 7: party-to-party visibility ("shared/private classification"). "private" means visible
 * only to the uploading party, never the counterparty — a distinct concern from
 * `shared_with_witnesses`, which only ever matters for evidence that is already "shared" (a witness
 * can never see something even the other agreement party cannot).
 */
export const evidenceVisibilityEnum = pgEnum("evidence_visibility", ["shared", "private"]);

/** Sprint 7: "withdrawal state" — withdrawn evidence is never deleted (audit/immutability), only excluded from being treated as active case material going forward. */
export const evidenceWithdrawalStateEnum = pgEnum("evidence_withdrawal_state", ["active", "withdrawn"]);

/**
 * Sprint 7: "malware/file validation abstraction." This environment has no real external
 * virus-scanning provider integrated (docs/ARCHITECTURE.md lists one as an unintegrated external
 * dependency) — `BasicFileValidator` performs synchronous size/type/magic-byte checks only, so
 * every stored row is set directly to "clean" or the upload is rejected before storage ever
 * happens; "pending" is reserved for a future real, asynchronous AV pipeline and is never actually
 * written by this sprint's code.
 */
export const evidenceFileValidationStatusEnum = pgEnum("evidence_file_validation_status", [
  "pending",
  "clean",
  "rejected",
]);

/** Sprint 8 (docs/sprints/SPRINT_08_Workflows_CSVImports.md): "invoice/PO/contract references" recorded against a B2B agreement. */
export const agreementReferenceTypeEnum = pgEnum("agreement_reference_type", [
  "invoice",
  "purchase_order",
  "contract",
]);

/** Sprint 8: CSV import batch lifecycle — UPLOAD -> VALIDATE -> (preview/error-report are read-only) -> CREATE DRAFTS. Never a "bulk activate" state; "drafts_created" only means individual draft agreements now exist, each still requiring its own submit/acknowledge/accept/sign. */
export const csvImportBatchStatusEnum = pgEnum("csv_import_batch_status", [
  "uploaded",
  "validated",
  "drafts_created",
]);

/** Sprint 8: per-row validation outcome — "pending" until validateBatch runs. */
export const csvImportRowValidationStatusEnum = pgEnum("csv_import_row_validation_status", [
  "pending",
  "valid",
  "invalid",
]);

/** Sprint 8: "duplicate check" outcome — checked both within the same file and against existing agreements. */
export const csvImportRowDuplicateStatusEnum = pgEnum("csv_import_row_duplicate_status", [
  "unique",
  "duplicate_in_file",
  "duplicate_existing_agreement",
]);

/**
 * Sprint 9 (docs/sprints/SPRINT_09_PaymentProviderAbstraction _Sandbox.md): the payment-attempt
 * lifecycle this sprint's provider-abstraction scope owns. Deliberately smaller than
 * docs/PAYMENT_STATE_MACHINE.md's full processor-integration lifecycle (scheduled/submitted/
 * processing/cleared/payout_pending/paid_out/returned) — that full state machine belongs to a real
 * processor adapter and the ledger (Sprint 10+), which this sprint does not build. "pending" covers
 * everything between creation and a provider's first definitive webhook/response; "disputed" is
 * reachable only via a webhook event, never set directly by application code.
 */
export const paymentAttemptStatusEnum = pgEnum("payment_attempt_status", [
  "pending",
  "succeeded",
  "failed",
  "canceled",
  "refunded",
  "disputed",
  // Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md): reserved for a card/network
  // chargeback ("Reversed" in docs/PAYMENT_STATE_MACHINE.md §1 — explicitly *not* an ACH concept
  // per that doc's method-nuance table). Not exercised by Sprint 11 (ACH); Sprint 12 (debit card)
  // owns this transition. Sprint 10 originally mislabeled this value's doc comment as covering late
  // ACH returns — corrected in Sprint 11 once the canonical state machine's Returned/Reversed
  // distinction was cross-checked; see "returned" below for the value ACH actually uses.
  "reversed",
  // Sprint 11 (docs/sprints/SPRINT_11_ACH_Sandbox.md) additions — the fuller granular lifecycle
  // docs/PAYMENT_STATE_MACHINE.md §1 models (Scheduled → Submitted → Processing → Cleared, plus the
  // ACH-specific late-return branch). "succeeded" continues to mean "Cleared" (unchanged, Sprint
  // 9); "pending" remains a valid catch-all for payment methods/tests that don't need this
  // granularity (Sprint 9's sandbox default).
  "scheduled",
  "submitted",
  "processing",
  // The correctly-named counterpart to "reversed" above — a late ACH return
  // (docs/PAYMENT_STATE_MACHINE.md §1: "Cleared/PayoutPending/PaidOut → Returned: late ACH
  // return"). The `payment.returned` webhook event (Sprint 10) now sets this instead of the
  // mislabeled "reversed".
  "returned",
]);

/**
 * Sprint 11 (docs/sprints/SPRINT_11_ACH_Sandbox.md): a borrower's mandate/authorization to debit
 * their bank account is either currently in force ("active") or not ("revoked" — by the borrower,
 * or superseded by a bank-change re-authorization; "expired" reserved for a future
 * provider-driven expiry signal, never set by this sprint's code). Exactly one of these states at
 * a time per mandate row — mandates are never deleted (audit/immutability, matching every other
 * table in this schema), only superseded by a new row.
 */
export const achMandateStatusEnum = pgEnum("ach_mandate_status", ["active", "revoked", "expired"]);

/**
 * Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md): the shadow-ledger chart of
 * accounts, matching docs/PAYMENT_ARCHITECTURE.md §14's illustrative accounts exactly (minus
 * `payout_in_transit`, since this sprint models payout as a single direct posting rather than a
 * two-step in-transit intermediate — see ledgerService.ts for why). One row per (account_type,
 * agreement_id) in `ledger_account`, created lazily — there is deliberately no "debtor_obligation"
 * account: original principal already lives in `agreement_version.terms` (Sprint 5) and the ledger
 * must never duplicate or rewrite it (this sprint's requirement #7).
 */
export const ledgerAccountTypeEnum = pgEnum("ledger_account_type", [
  "processor_clearing",
  "creditor_proceeds_payable",
  "platform_fee_revenue",
  "processor_fee_expense",
  "creditor_clawback_exposure",
  // Balancing counter-leg for administrative corrections only (requirement #18) — never touched by
  // any automatic/webhook-driven posting.
  "admin_adjustment_suspense",
]);

/**
 * Sprint 10: one row per balanced financial event. `payment_cleared` mirrors
 * docs/PAYMENT_ARCHITECTURE.md §14 posting 1; `payout` mirrors posting 2; `refund` (voluntary/
 * dispute-resolved) and `reversal` (bank/network-initiated return, e.g. ACH return) both mirror
 * posting 3 or 4 depending on whether a `payout` entry already exists for the same payment attempt
 * — see §10's "all three [return, chargeback, refund] converge on the same ledger operation."
 * `dispute_adjustment` is posted when a dispute is opened (freezing recoverable funds), using the
 * same shape, before any final resolution. `admin_adjustment` is the only entry type a human can
 * trigger directly, always balanced against `admin_adjustment_suspense`.
 */
export const ledgerEntryTypeEnum = pgEnum("ledger_entry_type", [
  "payment_cleared",
  "refund",
  "reversal",
  "payout",
  "dispute_adjustment",
  "admin_adjustment",
]);

export const ledgerPostingDirectionEnum = pgEnum("ledger_posting_direction", ["debit", "credit"]);

/**
 * Sprint 10 reconciliation exception vocabulary — matches the sprint's own required list exactly.
 * See reconciliationService.ts for which of these have live automated detectors in this sprint vs.
 * are reserved vocabulary for a future, fuller reconciliation pass.
 */
export const reconciliationExceptionTypeEnum = pgEnum("reconciliation_exception_type", [
  "missing_provider_transaction",
  "unmatched_provider_transaction",
  "amount_mismatch",
  "currency_mismatch",
  "duplicate_transaction",
  "status_mismatch",
  "reversal_refund_mismatch",
  "stale_pending_settlement",
  "internal_posting_failure",
  "provider_event_without_internal_state",
]);

/** Sprint 10: an exception stays "open" until an administrator (or a future automated repair) explicitly resolves it — reconciliation itself never auto-resolves anything, matching the sprint's "must not silently ignore mismatches." */
export const reconciliationExceptionStatusEnum = pgEnum("reconciliation_exception_status", ["open", "resolved"]);
