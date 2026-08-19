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
 * Sprint 12 (docs/sprints/SPRINT_12_DebitCard_Sandbox.md): which rail a `payment_attempt` used.
 * Nullable on the table — every pre-Sprint-12 row (Sprint 9's abstraction-level tests, Sprint 10's
 * ledger tests) has no method recorded and stays that way; only ACH (Sprint 11) and debit card
 * (this sprint) attempts set it. Exists specifically so ACH and card payment states can be queried
 * and reasoned about separately (master spec §6: "The system must separately track ACH and card
 * payment states") and so the fee-allocation engine below knows which processor-fee rate applied.
 */
/**
 * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md)
 * addition: "manual_off_platform" — a payment collected outside this platform's payment rails
 * entirely (cash, check, an external transfer) that a party records for evidentiary/bookkeeping
 * purposes, distinct from a provider-verified (ach/debit_card) attempt this platform itself
 * processed. Never routes through PaymentProvider — see paymentService.ts's
 * recordManualOffPlatformPayment.
 */
export const paymentMethodEnum = pgEnum("payment_method", ["ach", "debit_card", "manual_off_platform"]);

/**
 * Sprint 12: a debit card on file for an agreement, mirroring `ach_mandate_status`'s shape and the
 * same "expired reserved, never set directly" precedent — this sprint detects an expired card
 * lazily at payment-attempt time (comparing `expires_at_year`/`expires_at_month` to the current
 * date), it does not run a background job that flips this column. "replaced" is set the moment a
 * new card supersedes this one (mirrors `ach_mandate`'s bank-change hook), matching "replaced card"
 * from this sprint's required test list.
 */
export const debitCardMethodStatusEnum = pgEnum("debit_card_method_status", ["active", "replaced", "expired"]);

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

/**
 * Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md): the lifecycle of a single
 * scheduled automatic retry. "scheduled" is the only state a retry starts in; it becomes "fired"
 * once the cron-triggered scheduler route actually creates the retry's `payment_attempt` (see
 * `payment_retry.resulting_payment_attempt_id`), or "canceled" if a manual payment clears the same
 * installment first (this sprint's requirement #7). Exactly one `payment_retry` row is ever created
 * per original failed `payment_attempt` — enforced in `PaymentRetryService`, not by a DB constraint
 * alone — which is the concrete mechanism behind "never implement uncontrolled retries" /
 * "if retry fails, stop automatic retries": a retry's own resulting payment_attempt is never itself
 * treated as eligible for a further `payment_retry` row.
 */
export const paymentRetryStatusEnum = pgEnum("payment_retry_status", ["scheduled", "fired", "canceled"]);

/**
 * Sprint 13: a borrower-requested new due date for a past-due (or any) installment — requirement #9
 * ("Borrower may request new payment date") plus #10 ("Creditor approval required to formally
 * reschedule"). "pending" is the only state a request starts in; the installment's own `due_date`
 * is updated only once a creditor (or authorized business staff) explicitly approves — never on
 * request alone, which is the concrete mechanism behind "creditor approval required."
 */
export const rescheduleRequestStatusEnum = pgEnum("reschedule_request_status", ["pending", "approved", "rejected"]);

/**
 * Sprint 13: minimal internal notification-event ledger, per `docs/SPRINT_CONTROL.md`'s
 * "Sequencing risk 1" resolution — earlier sprints (this one first) write a durable event record;
 * Sprint 17 later wires real delivery channels (email/SMS/in-app) on top of these same rows without
 * requiring this sprint to be rebuilt. `notification_type` is a free-vocabulary text column, not an
 * enum, matching this sprint's own uncertainty about the full future vocabulary Sprint 17 will need
 * (docs/sprints/SPRINT_17_Notifications.md) — an enum would need editing by every sprint that adds a
 * new notification type, which is exactly the kind of forward-coupling this project's sprints
 * otherwise avoid (e.g. `payment_attempt.failure_reason` is also free text for the same reason).
 */

/**
 * Sprint 14 (docs/sprints/SPRINT_14_Amendments_Hardship.md): mirrors `docs/STATE_MACHINES.md` §3's
 * Amendment lifecycle exactly — `Proposed → AwaitingSignatures → Signed → Applied` (happy path),
 * `Proposed → Rejected` (counterparty rejects outright), `{Proposed,AwaitingSignatures} → Withdrawn`
 * (proposer withdraws). A counteroffer does not introduce a new state: it mutates the same row's
 * proposed terms in place and stays `proposed`, mirroring `AgreementService.creditorDecide`'s own
 * counter mechanic for the original (pre-signature) agreement exactly — see `amendmentService.ts`.
 * `Applied` is terminal and immutable, matching FR-AGR-006: the `agreement_version` it produces is
 * never edited in place, only ever superseded by a further amendment.
 */
export const amendmentStatusEnum = pgEnum("amendment_status", [
  "proposed",
  "awaiting_signatures",
  "signed",
  "applied",
  "rejected",
  "withdrawn",
]);

/**
 * Sprint 14: what kind of change a proposal represents, per this sprint's own required list ("new
 * date, temporary pause, reduced installment, revised schedule") plus `general` for any other
 * §3-listed contractual change (fee allocation, total balance, etc.) not covered by the other four.
 * `temporary_pause` is the one value with its own side effect on `Applied`: it transitions the
 * agreement to `paused_by_amendment` (`docs/STATE_MACHINES.md` §1: "Active → PausedByAmendment:
 * signed amendment applies an explicit pause term") — every other change type only ever creates a
 * new version, never touching `agreement.status` itself.
 */
export const amendmentChangeTypeEnum = pgEnum("amendment_change_type", [
  "new_date",
  "temporary_pause",
  "reduced_installment",
  "revised_schedule",
  "general",
]);

/**
 * Sprint 15 (docs/sprints/SPRINT_15_ PartialPayments_Settlement.md): `docs/STATE_MACHINES.md` §5's
 * Partial-payment request lifecycle, collapsed the same way Sprint 14 collapsed the illustrative
 * Hardship/Amendment split — `Submitted`/`UnderCreditorReview` are one status (`proposed`) and
 * `Approved`/`AwaitingPayment` are one status (`awaiting_payment`), since this sprint's own text
 * never describes a separate "approved but not yet awaiting payment" moment. `applied` matches
 * §5's own "does not itself change agreement status beyond recording the partial payment against
 * the installment" — no agreement_version is ever created for a partial payment.
 */
export const partialPaymentRequestStatusEnum = pgEnum("partial_payment_request_status", [
  "proposed",
  "awaiting_payment",
  "applied",
  "rejected",
  "expired",
]);

/**
 * Sprint 15: `docs/STATE_MACHINES.md` §6's Settlement lifecycle, with the same collapsing rationale
 * as `partialPaymentRequestStatusEnum` above — this sprint's instruction text never mentions a
 * signature step or a distinct `AmendmentInProgress` sub-phase for settlement (unlike Sprint 14's
 * amendments, which explicitly requires dual signatures), so `accepted` moves directly to
 * `awaiting_payment` rather than modeling a hand-off to the Amendment lifecycle. See
 * `docs/SPRINT_CONTROL.md`'s Sprint 15 implementation notes for the full rationale.
 */
export const settlementProposalStatusEnum = pgEnum("settlement_proposal_status", [
  "proposed",
  "awaiting_payment",
  "rejected",
  "completed",
  "failure_consequence_applied",
]);

/** Sprint 15: master spec §12's "whether payment is one-time or scheduled." */
export const settlementPaymentModeEnum = pgEnum("settlement_payment_mode", ["one_time", "scheduled"]);

/**
 * Sprint 15: master spec §12's four explicit failed-settlement consequence options, verbatim.
 * `restore_stated`/`forgive_permanently` each require their own stated amount, captured at proposal
 * time on `settlement_proposal.failure_consequence_stated_amount_minor_units` — see settlement.ts.
 */
export const settlementFailureConsequenceEnum = pgEnum("settlement_failure_consequence", [
  "restore_original",
  "restore_stated",
  "forgive_permanently",
  "prior_agreement_controls",
]);

/**
 * Sprint 16 (docs/sprints/SPRINT_16_Disputes.md): master spec §13's agreement-level dispute
 * lifecycle, matching `docs/STATE_MACHINES.md` §7 exactly except two adjacent states are collapsed
 * into one — `ResolvedWithAmendment` and `AmendmentInProgress` become `resolved_with_amendment`
 * (there is no separate action between "resolution requires a signed amendment" and "hands off to
 * the Amendment lifecycle"; `AgreementDisputeService.resolveWithAmendment` does both in one call) —
 * mirroring Sprint 14/15's own identical collapsing precedent for illustrative sub-states with no
 * distinct action of their own.
 */
export const agreementDisputeStatusEnum = pgEnum("agreement_dispute_status", [
  "opened",
  "under_review",
  "resolved_no_change",
  "resolved_with_amendment",
  "restricted",
  "closed",
]);

/** Sprint 16: this sprint's own example categories for "debt does not exist / incorrect amount / evidence challenged / administration challenged," plus `other` for anything else master spec §13's "existence, amount, evidence, or agreement administration" wording doesn't name explicitly. */
export const agreementDisputeCategoryEnum = pgEnum("agreement_dispute_category", [
  "debt_does_not_exist",
  "incorrect_amount",
  "evidence_challenged",
  "administration_challenged",
  "other",
]);

/**
 * Sprint 16: this sprint's own example categories for a payment-level unauthorized-payment claim
 * (FR-UPAY-001) — deliberately a separate, smaller vocabulary from `agreementDisputeCategoryEnum`,
 * matching "Do not conflate them" (this sprint's own instruction, verbatim) and
 * `docs/DATA_MODEL.md`'s "separate from agreement_dispute (FR-UPAY-006)" note on `payment_dispute`.
 */
export const paymentDisputeCategoryEnum = pgEnum("payment_dispute_category", [
  "unauthorized_ach",
  "unauthorized_debit_card",
  "processor_dispute",
]);

/**
 * Sprint 16: "the processor handles payment dispute outcome" (this sprint's own instruction,
 * verbatim) — `claimed` is the only status `PaymentDisputeService` itself ever sets from a party
 * action; `upheld`/`denied` are only ever set by `recordProcessorOutcome`, an admin-only method that
 * *records* the processor's own determination rather than the platform adjudicating it.
 */
export const paymentDisputeStatusEnum = pgEnum("payment_dispute_status", ["claimed", "upheld", "denied"]);

/** Sprint 17 (docs/sprints/SPRINT_17_Notifications.md): this sprint's own required channel list, verbatim. "in_app" delivers by existing — a `notification_event` row is itself the in-app notification, so that channel's own send step is a no-op that marks straight to `delivered` (see notificationService.ts). */
export const notificationChannelEnum = pgEnum("notification_channel", ["email", "sms", "in_app"]);

/**
 * Sprint 17: per-(recipient, notification_event row) delivery status — one row per channel per
 * logical event (see notificationEvent's own updated doc comment in paymentRetry.ts for why this
 * sprint fans a single `notify()` call out into multiple `notification_event` rows rather than
 * adding a channel-list column to one row). `sent` (handed to the provider, provider accepted it) is
 * kept distinct from `delivered` (provider confirmed actual receipt via webhook) — `in_app` skips
 * `sent` and goes straight from `pending` to `delivered` on insert, since existing *is* delivery for
 * that channel. PRSprint 14 (docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md) made this distinction
 * real for `email`: `NotificationService.deliver()` now marks `sent` on provider acceptance and only
 * a verified Resend delivery webhook (src/app/api/webhooks/email/resend/route.ts) advances a row to
 * `delivered`. `sms` still conflates the two (no real SMS provider exists yet — PRSprint 15's scope),
 * matching every prior sprint's "sandbox/mock only" precedent for that channel specifically.
 */
export const notificationStatusEnum = pgEnum("notification_status", ["pending", "sent", "delivered", "failed"]);

/**
 * Sprint 18A (docs/sprints/Sprint_18A_CooperativeAccountPairing_FinancialAccountLinking_
 * RelationshipArchitecture.md): the relationship lifecycle, matching that spec's §13 canonical
 * progression. Two states from the spec's own "additional states may include" list —
 * `disputed`/`archived` — are deliberately not included: dispute state already lives on
 * `agreement_dispute`/`payment_dispute` (Sprint 16) and is read from there rather than duplicated
 * here (a relationship whose governing agreement has an open dispute is queried, not flagged twice);
 * "archived" has no retention/purge workflow anywhere in this codebase yet (a Sprint 18/20 concern),
 * so adding the status now with no code path that ever sets it would be exactly the kind of
 * speculative, never-exercised state this project's sprints consistently avoid.
 */
export const relationshipStatusEnum = pgEnum("relationship_status", [
  "invited",
  "counterparty_linked",
  "identities_confirmed",
  "financial_setup_pending",
  "financial_accounts_ready",
  "agreement_pending",
  "agreement_ready",
  "signature_pending",
  "signed",
  "active",
  "restricted",
  "suspended",
  "closed",
  "cancelled",
]);

/** Sprint 18A: a relationship_participant's own membership status, independent of the relationship's own lifecycle status. */
export const relationshipParticipantStatusEnum = pgEnum("relationship_participant_status", ["invited", "linked", "active", "removed"]);

/**
 * Sprint 18A §6's invitation lifecycle. `draft`/`delivered`/`superseded` from the spec's own
 * illustrative state list are deliberately not included — invitations are created-and-sent
 * atomically (no separate draft-save step is in scope), no email-delivery-receipt webhook exists
 * anywhere in this codebase (Sprint 17's `ConsoleEmailSender` is log-only, so "delivered" could never
 * be genuinely distinguished from "sent"), and re-inviting after cancellation creates a fresh
 * invitation row rather than a `superseded` back-reference — simpler, and consistent with this
 * sprint's own "only include states that are justified by the existing architecture."
 */
export const relationshipInvitationStatusEnum = pgEnum("relationship_invitation_status", [
  "sent",
  "viewed",
  "accepted",
  "declined",
  "expired",
  "cancelled",
]);

/** Sprint 18A §15: which kind of financial account a party has on file. */
export const financialAccountTypeEnum = pgEnum("financial_account_type", ["bank_account", "debit_card"]);

/** Sprint 18A §17: the relationship layer's own authoritative verification vocabulary, consumed from (never re-implemented on top of) Sprint 11/12's existing ACH mandate / debit-card verification concepts — see relationshipFinancialAccountService.ts's doc comment. */
export const financialAccountStatusEnum = pgEnum("financial_account_status", ["pending_verification", "verified", "failed", "disabled"]);

/** Sprint 18A §19: "where money is pulled from" vs. "where money is delivered" — deliberately always distinct (no `both` value): every payment rail this codebase supports (ACH, debit card) is either a funding-only or payout-only rail today, so a single account claiming both roles at once has no real code path to exercise, per this sprint's own "use BOTH only if technically supported." */
export const financialAccountUsageEnum = pgEnum("financial_account_usage", ["funding", "payout"]);

/** Sprint 18A §19: an assignment's own lifecycle — `active` is the current, in-effect assignment for its (relationship, usage) slot; `superseded` is immutable history, never deleted (this sprint's own "do not overwrite history"). */
export const relationshipFinancialAccountAssignmentStatusEnum = pgEnum("relationship_financial_account_assignment_status", [
  "active",
  "superseded",
]);

/**
 * Sprint 18 (docs/sprints/SPRINT_18_AdminSupport_Appeals.md): the fine-grained internal-staff role a
 * `platform_admin` (Sprint 6A) may additionally hold, narrowing which admin capabilities they may
 * exercise — entirely separate from `PlatformRole` (member/platform_admin/platform_owner), which
 * remains the base gate every Sprint 18 action still requires first. Mirrors Sprint 4's
 * business-staff role/capability split, applied to platform-level (not per-business) staff. "admin"
 * always has every Sprint 18 capability, the same structural-bypass precedent as Sprint 4's "owner"
 * (see adminRoleService.ts) — never needing to be kept in sync as capabilities are added.
 */
export const internalAdminRoleEnum = pgEnum("internal_admin_role", ["support", "compliance", "fraud_reviewer", "admin"]);

/**
 * Sprint 18: "retention hold, dispute hold, fraud-review hold, litigation/legal hold, administrative
 * retention override" — this sprint's own required hold-type vocabulary, verbatim. Deliberately a
 * closed enum (unlike `notification_type`/`relationship.context`'s free-text precedent) — this
 * sprint's own file names an exact, fixed list with no "additional types may include" language, so
 * there is no open vocabulary to preserve room for.
 */
export const retentionHoldTypeEnum = pgEnum("retention_hold_type", ["retention", "dispute", "fraud_review", "litigation", "administrative_override"]);

/** Sprint 18: "restrict payment activity," "restrict new agreements," "restrict payouts where permitted" — this sprint's own required restriction vocabulary. Deliberately excludes account suspension: Sprint 6A's `AdminService.suspendUser`/`reactivateUser` already own that exact behavior and are reused unchanged, not duplicated here. */
export const adminRestrictionTypeEnum = pgEnum("admin_restriction_type", ["payment_activity", "new_agreement_creation", "payout"]);

/** Sprint 18: a support case's own lifecycle. */
export const supportCaseStatusEnum = pgEnum("support_case_status", ["open", "in_review", "resolved", "closed"]);

/** Sprint 18 §30 Appeals: "keep restrictions in place during review unless an authorized reviewer lifts them" — `submitted` and `under_review` are both still-pending states (assigning a reviewer moves `submitted` → `under_review`); `decided` is terminal. */
export const appealStatusEnum = pgEnum("appeal_status", ["submitted", "under_review", "decided"]);

/** Sprint 18 §30: the three outcomes a reviewer may record — "partially_overturned" exists because a restriction is frequently narrower or broader than what full reversal would imply (e.g. a payout restriction upheld but its duration shortened), not because the platform is adjudicating fault (no such field exists on this table — see appealService.ts's own doc comment). */
export const appealDecisionEnum = pgEnum("appeal_decision", ["upheld", "overturned", "partially_overturned"]);

/**
 * PRSprint 24 (docs/prsprints/PRSPRINT_24_DEBIT_CARD_ISSUANCE_CARD_LIFECYCLE.md): a PAY2PAY-issued
 * card's own lifecycle, per this PRSprint's required list verbatim (cardholder creation through
 * lost/stolen). "expired" is deliberately not a stored state — mirrors
 * `debitCardMethodStatusEnum`'s identical "expired reserved, never set directly" precedent
 * (src/lib/debitCard/debitCardMethodService.ts's lazy, read-time `isExpired` check); an issued card's
 * expiry is derived from `expires_at_month`/`expires_at_year` the same way.
 */
export const issuedCardStatusEnum = pgEnum("issued_card_status", [
  "requested",
  "pending_issuance",
  "issued",
  "active",
  "frozen",
  "lost",
  "stolen",
  "replaced",
  "canceled",
]);

/** PRSprint 24: "virtual/physical issuance" — this PRSprint's own required distinction. */
export const issuedCardTypeEnum = pgEnum("issued_card_type", ["virtual", "physical"]);

/**
 * PRSprint 24: "Auth/clearing/settlement/decline/reversal states" — this PRSprint's own required
 * list verbatim (SPRINT_18C_PRODUCTION_READY.md item 107: "Do not treat card authorization as final
 * settlement... Handle: authorization; capture/clearing; settlement; reversal; decline.").
 */
export const cardTransactionEventTypeEnum = pgEnum("card_transaction_event_type", [
  "authorization",
  "clearing",
  "settlement",
  "decline",
  "reversal",
]);
