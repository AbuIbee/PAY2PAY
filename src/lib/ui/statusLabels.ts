/**
 * Sprint 18B: centralized backend-enum -> plain-language label mapping
 * ("Create centralized mapping from backend enums to user language. Do not
 * leak raw enum strings."). One export per domain enum (matching
 * src/db/schema/enums.ts exactly, value-for-value — verified against that
 * file, not guessed). Every status-chip-rendering component should import
 * from here rather than hand-rolling its own switch statement, so wording
 * only ever needs to change in one place.
 *
 * `tone` selects the visual treatment (see .chip--<tone> in app-shell.css)
 * and must never be the only signal (color) — callers also render `label`
 * as text, satisfying the "non-color status cues" accessibility requirement.
 */
export type ChipTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface StatusLabel {
  label: string;
  tone: ChipTone;
}

function registry<K extends string>(map: Record<K, StatusLabel>) {
  return (value: K): StatusLabel => map[value] ?? { label: value, tone: "neutral" };
}

export const agreementStatusLabel = registry<
  | "draft"
  | "awaiting_debtor_acknowledgment"
  | "awaiting_creditor_acceptance"
  | "awaiting_signatures"
  | "signed"
  | "first_payment_pending"
  | "active"
  | "past_due"
  | "disputed"
  | "paused_by_amendment"
  | "paid_in_full"
  | "settled_in_full"
  | "mutually_canceled"
  | "closed"
>({
  draft: { label: "Draft", tone: "neutral" },
  awaiting_debtor_acknowledgment: { label: "Awaiting acknowledgment", tone: "info" },
  awaiting_creditor_acceptance: { label: "Awaiting acceptance", tone: "info" },
  awaiting_signatures: { label: "Waiting for signatures", tone: "info" },
  signed: { label: "Signed", tone: "success" },
  first_payment_pending: { label: "First payment pending", tone: "info" },
  active: { label: "Active", tone: "success" },
  past_due: { label: "Past due", tone: "danger" },
  disputed: { label: "Disputed", tone: "danger" },
  paused_by_amendment: { label: "Paused", tone: "warning" },
  paid_in_full: { label: "Paid in full", tone: "success" },
  settled_in_full: { label: "Settled in full", tone: "success" },
  mutually_canceled: { label: "Canceled", tone: "neutral" },
  closed: { label: "Closed", tone: "neutral" },
});

export const installmentItemStatusLabel = registry<"scheduled" | "paid" | "past_due" | "waived">({
  scheduled: { label: "Scheduled", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  past_due: { label: "Past due", tone: "danger" },
  waived: { label: "Waived", tone: "neutral" },
});

export const paymentAttemptStatusLabel = registry<
  | "pending"
  | "succeeded"
  | "failed"
  | "canceled"
  | "refunded"
  | "disputed"
  | "reversed"
  | "scheduled"
  | "submitted"
  | "processing"
  | "returned"
>({
  pending: { label: "Pending", tone: "info" },
  succeeded: { label: "Cleared", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  canceled: { label: "Canceled", tone: "neutral" },
  refunded: { label: "Refunded", tone: "neutral" },
  disputed: { label: "Disputed", tone: "danger" },
  reversed: { label: "Reversed", tone: "danger" },
  scheduled: { label: "Scheduled", tone: "neutral" },
  submitted: { label: "Submitted", tone: "info" },
  processing: { label: "Processing", tone: "info" },
  returned: { label: "Returned", tone: "danger" },
});

export const achMandateStatusLabel = registry<"active" | "revoked" | "expired">({
  active: { label: "Mandate active", tone: "success" },
  revoked: { label: "Authorization revoked", tone: "danger" },
  expired: { label: "Mandate expired", tone: "warning" },
});

export const debitCardMethodStatusLabel = registry<"active" | "replaced" | "expired">({
  active: { label: "Active", tone: "success" },
  replaced: { label: "Replaced", tone: "neutral" },
  expired: { label: "Expired", tone: "warning" },
});

export const financialAccountStatusLabel = registry<"pending_verification" | "verified" | "failed" | "disabled">({
  pending_verification: { label: "Verification pending", tone: "info" },
  verified: { label: "Verified", tone: "success" },
  failed: { label: "Verification failed", tone: "danger" },
  disabled: { label: "Disabled", tone: "neutral" },
});

/**
 * PRSprint 24 (docs/prsprints/PRSPRINT_24_DEBIT_CARD_ISSUANCE_CARD_LIFECYCLE.md): a PAY2PAY-issued
 * card's own lifecycle status — distinct from `debitCardMethodStatusLabel` above (that one is a
 * card-on-file the *debtor* registers for charging; this one is a card PAY2PAY issues to a
 * cardholder to spend). "Do not present sandbox/test capabilities as production-live" is handled by
 * the page copy, not this label set — these are the same words a live card program would use.
 */
export const issuedCardStatusLabel = registry<
  "requested" | "pending_issuance" | "issued" | "active" | "frozen" | "lost" | "stolen" | "replaced" | "canceled"
>({
  requested: { label: "Requested", tone: "info" },
  pending_issuance: { label: "Issuing", tone: "info" },
  issued: { label: "Ready to activate", tone: "info" },
  active: { label: "Active", tone: "success" },
  frozen: { label: "Frozen", tone: "warning" },
  lost: { label: "Reported lost", tone: "danger" },
  stolen: { label: "Reported stolen", tone: "danger" },
  replaced: { label: "Replaced", tone: "neutral" },
  canceled: { label: "Canceled", tone: "neutral" },
});

export const rescheduleRequestStatusLabel = registry<"pending" | "approved" | "rejected">({
  pending: { label: "Awaiting creditor decision", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
});

export const amendmentStatusLabel = registry<
  "proposed" | "awaiting_signatures" | "signed" | "applied" | "rejected" | "withdrawn"
>({
  proposed: { label: "Proposed", tone: "info" },
  awaiting_signatures: { label: "Waiting for signatures", tone: "info" },
  signed: { label: "Signed", tone: "success" },
  applied: { label: "Applied", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
});

export const amendmentChangeTypeLabel = registry<
  "new_date" | "temporary_pause" | "reduced_installment" | "revised_schedule" | "general"
>({
  new_date: { label: "New due date", tone: "neutral" },
  temporary_pause: { label: "Temporary pause", tone: "neutral" },
  reduced_installment: { label: "Reduced installment", tone: "neutral" },
  revised_schedule: { label: "Revised schedule", tone: "neutral" },
  general: { label: "Other change", tone: "neutral" },
});

export const partialPaymentRequestStatusLabel = registry<
  "proposed" | "awaiting_payment" | "applied" | "rejected" | "expired"
>({
  proposed: { label: "Proposed", tone: "info" },
  awaiting_payment: { label: "Payment required", tone: "warning" },
  applied: { label: "Applied", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  expired: { label: "Expired", tone: "neutral" },
});

/**
 * "Accepted" must never visually equal "Paid"/"Completed" (Sprint 15's own
 * hard rule) — note `awaiting_payment` and `completed` are deliberately
 * different tones/labels even though both follow acceptance.
 */
export const settlementProposalStatusLabel = registry<
  "proposed" | "awaiting_payment" | "rejected" | "completed" | "failure_consequence_applied"
>({
  proposed: { label: "Proposed", tone: "info" },
  awaiting_payment: { label: "Accepted — payment required", tone: "warning" },
  rejected: { label: "Rejected", tone: "danger" },
  completed: { label: "Completed", tone: "success" },
  failure_consequence_applied: { label: "Failed — consequence applied", tone: "danger" },
});

export const agreementDisputeStatusLabel = registry<
  "opened" | "under_review" | "resolved_no_change" | "resolved_with_amendment" | "restricted" | "closed"
>({
  opened: { label: "Opened", tone: "warning" },
  under_review: { label: "Under review", tone: "info" },
  resolved_no_change: { label: "Resolved — no change", tone: "success" },
  resolved_with_amendment: { label: "Resolved — amendment applied", tone: "success" },
  restricted: { label: "Restricted pending review", tone: "danger" },
  closed: { label: "Closed", tone: "neutral" },
});

export const paymentDisputeStatusLabel = registry<"claimed" | "upheld" | "denied">({
  claimed: { label: "Claim submitted", tone: "warning" },
  upheld: { label: "Claim upheld", tone: "success" },
  denied: { label: "Claim denied", tone: "danger" },
});

export const relationshipStatusLabel = registry<
  | "invited"
  | "counterparty_linked"
  | "identities_confirmed"
  | "financial_setup_pending"
  | "financial_accounts_ready"
  | "agreement_pending"
  | "agreement_ready"
  | "signature_pending"
  | "signed"
  | "active"
  | "restricted"
  | "suspended"
  | "closed"
  | "cancelled"
>({
  invited: { label: "Invitation sent", tone: "info" },
  counterparty_linked: { label: "Connected", tone: "info" },
  identities_confirmed: { label: "Identities confirmed", tone: "info" },
  financial_setup_pending: { label: "Setting up accounts", tone: "info" },
  financial_accounts_ready: { label: "Accounts ready", tone: "info" },
  agreement_pending: { label: "Agreement in progress", tone: "info" },
  agreement_ready: { label: "Agreement ready", tone: "info" },
  signature_pending: { label: "Waiting for signatures", tone: "info" },
  signed: { label: "Signed", tone: "success" },
  active: { label: "Active", tone: "success" },
  restricted: { label: "Restricted", tone: "danger" },
  suspended: { label: "Suspended", tone: "danger" },
  closed: { label: "Closed", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
});

export const relationshipInvitationStatusLabel = registry<
  "sent" | "viewed" | "accepted" | "declined" | "expired" | "cancelled"
>({
  sent: { label: "Sent", tone: "info" },
  viewed: { label: "Viewed", tone: "info" },
  accepted: { label: "Accepted", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  expired: { label: "Expired", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
});

export const verificationStatusLabel = registry<"pending" | "verified" | "rejected">({
  pending: { label: "Verification pending", tone: "info" },
  verified: { label: "Verified", tone: "success" },
  rejected: { label: "Verification rejected", tone: "danger" },
});

export const supportCaseStatusLabel = registry<"open" | "in_review" | "resolved" | "closed">({
  open: { label: "Open", tone: "info" },
  in_review: { label: "In review", tone: "warning" },
  resolved: { label: "Resolved", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
});

export const appealStatusLabel = registry<"submitted" | "under_review" | "decided">({
  submitted: { label: "Submitted", tone: "info" },
  under_review: { label: "Under review", tone: "warning" },
  decided: { label: "Decided", tone: "success" },
});

export const appealDecisionLabel = registry<"upheld" | "overturned" | "partially_overturned">({
  upheld: { label: "Upheld", tone: "neutral" },
  overturned: { label: "Overturned", tone: "success" },
  partially_overturned: { label: "Partially overturned", tone: "info" },
});

export const retentionHoldTypeLabel = registry<
  "retention" | "dispute" | "fraud_review" | "litigation" | "administrative_override"
>({
  retention: { label: "Retention hold", tone: "neutral" },
  dispute: { label: "Dispute hold", tone: "warning" },
  fraud_review: { label: "Fraud review hold", tone: "warning" },
  litigation: { label: "Legal hold", tone: "danger" },
  administrative_override: { label: "Administrative hold", tone: "neutral" },
});

export const adminRestrictionTypeLabel = registry<"payment_activity" | "new_agreement_creation" | "payout">({
  payment_activity: { label: "Payment activity restricted", tone: "danger" },
  new_agreement_creation: { label: "New agreements restricted", tone: "danger" },
  payout: { label: "Payouts restricted", tone: "danger" },
});

export const staffInvitationStatusLabel = registry<"pending" | "accepted" | "expired" | "revoked">({
  pending: { label: "Invitation pending", tone: "info" },
  accepted: { label: "Accepted", tone: "success" },
  expired: { label: "Expired", tone: "neutral" },
  revoked: { label: "Revoked", tone: "neutral" },
});

export const approvalRequestStatusLabel = registry<"pending" | "approved" | "rejected">({
  pending: { label: "Awaiting approval", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
});

export const reconciliationExceptionStatusLabel = registry<"open" | "resolved">({
  open: { label: "Open", tone: "warning" },
  resolved: { label: "Resolved", tone: "success" },
});

export const csvImportBatchStatusLabel = registry<"uploaded" | "validated" | "drafts_created">({
  uploaded: { label: "Uploaded", tone: "info" },
  validated: { label: "Validated", tone: "info" },
  drafts_created: { label: "Drafts created", tone: "success" },
});

/**
 * Sprint 4's 13-capability model, translated to user-facing language.
 * Reused wherever a role or custom-role's capability list is shown (staff
 * management, custom-role editor, approval-request context).
 */
export const businessCapabilityLabel: Record<string, string> = {
  create_agreement: "Create agreements",
  send_invitation: "Invite counterparties",
  approve_agreement: "Approve agreements",
  propose_amendment: "Propose amendments",
  approve_hardship: "Approve hardship requests",
  approve_partial_payment: "Approve partial payments",
  approve_settlement: "Approve settlements",
  forgive_principal: "Forgive principal",
  export_records: "Export records",
  view_reports: "View reports",
  manage_staff: "Manage staff",
  change_payout_configuration: "Manage payout accounts",
  approve_high_value_action: "Approve high-value actions",
};

/**
 * Sprint 17's 25-event notification vocabulary (src/lib/notify/eventTypes.ts), translated to
 * plain-language titles for the Notification Center. Deep-link `hrefBase` values point at the
 * pages built elsewhere in Sprint 18B; a notification's own `context`/`referenceId` (not modeled
 * here) supplies the id query param at render time.
 */
export const notificationEventLabel: Record<string, string> = {
  agreement_invitation: "Agreement invitation",
  agreement_signed: "Agreement signed",
  amendment: "Amendment update",
  payment_scheduled: "Payment scheduled",
  payment_processing: "Payment processing",
  payment_cleared: "Payment cleared",
  payment_failed: "Payment failed",
  payment_disputed: "Payment disputed",
  bank_change: "Bank account changed",
  card_change: "Card changed",
  authorization_revoked: "Authorization revoked",
  hardship: "Hardship update",
  partial_payment: "Partial payment update",
  settlement: "Settlement update",
  security_event: "Security alert",
  staff_permissions: "Staff permissions changed",
  payout_account_change: "Payout account changed",
  account_restriction: "Account restriction",
  relationship_invitation: "Connection invitation",
  relationship_accepted: "Connection accepted",
  relationship_declined: "Connection declined",
  relationship_activated: "Connection active",
  relationship_restricted: "Connection restricted",
  relationship_funding_account_replaced: "Funding account changed",
  relationship_payout_account_replaced: "Payout account changed",
  appeal_decided: "Appeal decided",
  // PRSprint 13 added these four (docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md) but never
  // added labels for them — every one of these previously rendered as its raw enum string in the
  // Notification Center (`titleFor`'s own `?? record.notificationType` fallback), exactly the "raw
  // infrastructure" leak PRSprint 16 (docs/prsprints/PRSPRINT_16_NOTIFICATION_PREFERENCES_DELIVERY_HISTORY.md)
  // requirement #19 prohibits. Fixed here, not silently left.
  agreement_invitation_response: "Proposal update",
  agreement_action_required: "Agreement needs your attention",
  agreement_decided: "Agreement decision",
  agreement_counterparty_signed: "Signature needed",
  amendment_decided: "Amendment decision",
  agreement_cancellation_requested: "Cancellation requested",
  agreement_cancellation_decided: "Cancellation decision",
};

/**
 * PRSprint 16 (docs/prsprints/PRSPRINT_16_NOTIFICATION_PREFERENCES_DELIVERY_HISTORY.md), requirement
 * #20/#34: per-channel delivery status, in plain language, for the Notification Center's grouped
 * history view — never "provider_accepted"/"bounced"/other infrastructure terms. `sent` and
 * `delivered` are deliberately different labels (not conflated) — "sent" means the provider accepted
 * it, "delivered" means the provider later confirmed real delivery via its own webhook; see
 * notificationService.ts's own `deliver()` doc comments for the underlying distinction this reflects,
 * not invents.
 */
export function notificationDeliveryStatusLabel(status: "pending" | "sent" | "delivered" | "failed" | "not_sent"): StatusLabel {
  switch (status) {
    case "pending":
      return { label: "Pending", tone: "neutral" };
    case "sent":
      return { label: "Sent", tone: "info" };
    case "delivered":
      return { label: "Delivered", tone: "success" };
    case "failed":
      return { label: "Could not send", tone: "danger" };
    case "not_sent":
      return { label: "Not sent", tone: "neutral" };
  }
}

/** Sprint 18's internal-admin capability model, translated to user-facing language. */
export const adminCapabilityLabel: Record<string, string> = {
  suspend_account: "Suspend account",
  restrict_payment_activity: "Restrict payments",
  restrict_new_agreements: "Restrict new agreements",
  restrict_payout: "Restrict payouts",
  review_verification_status: "Review verification",
  review_fraud_alert: "Review fraud alerts",
  review_payment_failures: "Review payment failures",
  review_dispute: "Review disputes",
  review_audit_logs: "View audit log",
  manage_support_case: "Manage support cases",
  manage_appeal: "Review appeals",
  place_retention_hold: "Place legal holds",
  release_retention_hold: "Release legal holds",
};

/**
 * PRSprint 25: plain-language party-role label ("Avoid overusing financial
 * jargon" / master-spec item 49) — pairs the friendly phrase with the
 * precise term in parentheses so a user who has learned "creditor"/"debtor"
 * from elsewhere on the page isn't left guessing which one they are.
 */
export function partyRoleLabel(role: "creditor" | "debtor"): string {
  return role === "creditor" ? "receiving repayment (creditor)" : "making repayment (debtor)";
}

/** PRSprint 25: plain-language fee-allocation label — never leak the raw `creditor_pays`/`debtor_pays` enum string into the UI. */
export function feeAllocationLabel(allocation: "creditor_pays" | "debtor_pays" | "split_evenly"): string {
  switch (allocation) {
    case "creditor_pays":
      return "Paid by the person receiving repayment";
    case "debtor_pays":
      return "Paid by the person making repayment";
    case "split_evenly":
      return "Split evenly between both parties";
  }
}
