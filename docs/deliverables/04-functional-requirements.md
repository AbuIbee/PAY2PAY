# Deliverable 4: Functional Requirements

Source: `docs/PAY2PAY_MASTER_SPEC.md`. Requirements are grouped by spec area and uniquely numbered
`FR-<AREA>-<NNN>`. Each cites the governing spec section(s) for traceability and carries acceptance
criteria. Requirements consolidate closely related spec rules rather than restating every bullet as
a separate line item; nothing here adds a business rule beyond the spec — where the spec leaves a
number, threshold, or mechanism unresolved, the requirement says "configurable" or points to
`docs/OPEN_DECISIONS.md` instead of inventing a value.

## AGR — Agreement creation & content (Spec §3, §4)

**FR-AGR-001 — Either-party draft initiation.** Either the person owed money or the person who owes
it may create a draft agreement.
- AC1: A draft can be created by a user acting as prospective creditor or prospective borrower.
- AC2: A draft is not visible to, or binding on, the counterparty until it is sent via invitation (§22).

**FR-AGR-002 — Required agreement fields.** Every agreement must capture the full field set in §4
before it can leave Draft status: debt category, plain-language description, original amount,
payments already made, remaining balance, optional supporting documentation, recipient identity,
payer identity, payment method, mandatory first-payment amount, remaining installment schedule,
payment frequency, first scheduled payment, final scheduled payment, fee allocation (who pays
processing fees), early-payment terms, hardship terms, partial-payment terms, settlement terms,
dispute procedures, electronic-signature consent, payment authorization, and optional witnesses.
- AC1: The system blocks progression out of Draft if any required field is missing.
- AC2: Legitimate original-transaction charges (price, tax, shipping, installation, permit/filing
  costs) may be included as line items; the system rejects any charge flagged as added solely for
  paying over time.

**FR-AGR-003 — Borrower acknowledgment.** The borrower must formally acknowledge that the debt
exists, its reason, the amount, prior payments, the remaining balance, the repayment terms, and the
payment authorization before the agreement can proceed to creditor acceptance.
- AC1: Acknowledgment is captured as a distinct, attributable event, separate from final signing.
- AC2: An agreement cannot reach Awaiting recipient acceptance without a completed borrower
  acknowledgment event.

**FR-AGR-004 — Creditor acceptance.** The creditor must explicitly review and accept the
acknowledged terms before signatures are collected.
- AC1: Acceptance is a distinct, attributable event separate from signing.

**FR-AGR-005 — Dual electronic signature required for activation.** Both parties must electronically
sign before an agreement can leave Awaiting signatures.
- AC1: Signature capture meets the requirements of FR-SIG-001.
- AC2: An agreement with only one signature cannot transition to Signed.

**FR-AGR-006 — Post-signature immutability.** After both signatures, the agreement locks; the
originally signed version is never overwritten.
- AC1: Any attempt to modify a signed agreement's terms directly (outside the amendment flow) is
  rejected at the data layer, not just the UI.
- AC2: Every amendment creates a new, distinct version while the original signed version remains
  retrievable unchanged.

**FR-AGR-007 — Amendments require both-party approval.** Any change to total balance, installment
amount, frequency, due dates, start/end date, first-payment amount, final installment, fee
allocation, hardship terms, settlement terms, payment pauses, partial-payment terms, cancellation,
or debt forgiveness requires a signed amendment from both parties.
- AC1: No listed field can be changed by a single party's action alone.
- AC2: Each amendment is independently versioned and signed, with its own capture per FR-SIG-001.

**FR-AGR-008 — Independent ACH revocation.** The borrower may revoke ACH authorization or disconnect
a payment method independently, where legally required, without counterparty approval.
- AC1: Revocation stops future automatic debits immediately.
- AC2: Revocation does **not** delete, close, or alter the underlying signed debt agreement or its balance.

## FPAY — Mandatory first payment (Spec §5)

**FR-FPAY-001 — First payment required on every new agreement.** Every ordinary new agreement
requires an immediate first payment of a mutually agreed amount (not required to equal the
recurring installment).
- AC1: The signing flow cannot be completed as "Active" without a first-payment attempt being
  initiated.
- AC2: The first-payment amount is captured and confirmed during agreement creation, not
  improvised at signing time.

**FR-FPAY-002 — Computed schedule display.** The system calculates and displays total acknowledged
debt, first payment, remaining principal, number of later installments, later installment amounts,
frequency, final payment, and any rounding-caused uneven final payment.
- AC1: Displayed figures are recalculated and re-shown whenever any input to the schedule changes.
- AC2: Rounding differences are absorbed into the final installment, never silently distributed as
  a hidden fee.

**FR-FPAY-003 — Signed agreement survives first-payment failure.** A signed agreement remains valid
even if the first payment fails; only the automated recurring schedule is blocked from full
activation.
- AC1: A failed first payment does not revert agreement status below Signed.
- AC2: A failed first payment routes into the Failed-payment workflow (FR-FAIL) applied to that
  specific payment.

**FR-FPAY-004 — Agreement status progression.** Agreement status must progress through the ordered
set of states defined in §5 (Draft, Awaiting payer acknowledgment, Awaiting recipient acceptance,
Awaiting signatures, Signed, First payment pending, Active, Past due, Disputed, Paused by amendment,
Settled in full, Paid in full, Canceled by mutual agreement, Closed).
- AC1: State transitions are enforced server-side; invalid transitions are rejected (full state
  machine detailed in Deliverable 8).

## PAYMETHOD — Payment methods (Spec §6)

**FR-PAYMETHOD-001 — ACH and debit-card support.** The U.S. launch supports ACH bank payments and
debit cards, with ACH presented as the standard, low-cost default.
- AC1: A user creating or signing an agreement selects a payment method from exactly these two
  options at MVP launch.

**FR-PAYMETHOD-002 — No storage of raw payment credentials.** The application never stores raw
bank-account credentials or complete debit-card numbers; sensitive payment data is collected and
tokenized exclusively by a qualified, PCI-appropriate payments provider.
- AC1: Database schema contains no column capable of holding a full PAN, CVV, or raw bank
  account/routing number pair as plaintext.
- AC2: All payment-method references in application data are provider tokens/IDs only.

**FR-PAYMETHOD-003 — Fee allocation is explicit and enforced.** The signed agreement specifies who
pays the payment-processing fee; the creditor's expected net proceeds cannot be reduced without
mutual approval.
- AC1: If a borrower switches from ACH to a costlier method (e.g., debit card) after signing, the
  incremental processing cost defaults to the borrower unless an amendment reallocates it.
- AC2: Any change to fee allocation follows the amendment flow (FR-AGR-007).

**FR-PAYMETHOD-004 — Separate ACH and card payment state tracking.** ACH and debit-card payments are
tracked through distinct state representations reflecting their different failure/timing behavior
(ACH: pending → later failure possible; card: fail/expire/replace/dispute).
- AC1: The payment state machine (Deliverable 8) models ACH-specific and card-specific terminal and
  transitional states separately, not through one generic "paid/unpaid" flag.

## ROUTE — Payment routing & payouts (Spec §7)

**FR-ROUTE-001 — Processor-routed payouts to verified recipient.** Successful payments route from
payer to verified recipient through the qualified payment processor; the platform does not
intentionally receive customer funds into its own operating account.
- AC1: Recipient payout is tied to the processor's connected-account/payout mechanism, not an
  internal PAY2PAY-controlled disbursement step.

**FR-ROUTE-002 — Recipients paid only on clearing.** Recipients receive funds only as each
installment successfully clears; no platform-funded advances, guaranteed payouts, or instant access
to unsettled ACH funds exist in the MVP.
- AC1: Payout initiation cannot occur while the corresponding payment is in a pre-Cleared state.

**FR-ROUTE-003 — Payment state machine coverage.** The payment lifecycle must model: Scheduled,
Submitted, Processing, Cleared, Payout pending, Paid out, Failed, Returned, Reversed, Disputed,
Refunded, Canceled — with explicit allowed/prohibited transitions (delivered in full in Deliverable 8).
- AC1: Every payment record's current state is always one of the defined enum values; no
  free-text or null payment status is persisted once a payment is Scheduled.

## FAIL — Failed-payment workflow (Spec §8)

**FR-FAIL-001 — Immediate notification with non-sensitive failure category.** On any payment
failure, both parties are notified immediately with a category (e.g., "insufficient funds," "card
declined") that never exposes raw processor/bank decline codes or sensitive account data.

**FR-FAIL-002 — Manual payment always available post-failure.** The borrower may make a manual
payment for the failed installment at any time after the failure is recorded.

**FR-FAIL-003 — Exactly one automatic retry.** The system schedules exactly one automatic retry
after a configurable delay (default recommendation: three business days); the retry is canceled if
the borrower pays manually first; if the retry also fails, automatic attempts stop for that
installment.
- AC1: No installment receives more than one system-initiated automatic retry.
- AC2: The retry delay is a configurable value, not hard-coded.

**FR-FAIL-004 — Reschedule requires recipient approval.** A borrower's request for a new date on a
failed installment requires explicit recipient approval before becoming a formal reschedule.

**FR-FAIL-005 — No automatic late fees.** The system never applies a late fee automatically as a
consequence of a failed or retried payment.

**FR-FAIL-006 — Failed installments preserved in history.** An unpaid/failed installment record is
retained in the agreement's history regardless of how it is eventually resolved.

## HARD — Hardship workflow (Spec §9)

**FR-HARD-001 — Structured hardship request.** A borrower may request a new payment date, temporary
pause, reduced installments, or a revised schedule, submitting reason, requested relief, proposed
effective date, and proposed replacement terms.

**FR-HARD-002 — Creditor accept/reject/counteroffer.** The creditor may accept, reject, or
counteroffer any hardship request.

**FR-HARD-003 — Existing terms remain controlling until signed amendment.** The pre-hardship
agreement stays fully in force and enforceable until both parties sign a hardship amendment.

**FR-HARD-004 — No interest, growth, or penalty from hardship.** A hardship amendment can never
introduce interest, balance growth, or a penalty charge, regardless of the relief granted.

## EARLY — Early payments (Spec §10)

**FR-EARLY-001 — No penalty for extra or early payment.** A borrower may pay additional principal or
pay off the full balance early at any time without penalty.

**FR-EARLY-002 — Full payoff auto-closes agreement.** A cleared payment that brings the remaining
balance to zero automatically transitions the agreement to Paid in full without requiring separate
creditor action.

**FR-EARLY-003 — Partial extra-payment treatment choice.** For an extra payment that does not fully
pay off the balance, the borrower may propose either keeping the installment amount and finishing
sooner, or reducing future installments while preserving the original final date; either requires
creditor approval and a signed amendment.

## PART — Partial payments (Spec §11)

**FR-PART-001 — Pre-approval required.** A borrower cannot make a partial payment on a scheduled
installment without prior creditor approval of that specific partial payment.

**FR-PART-002 — Structured partial-payment request.** The request includes proposed amount,
proposed date, optional explanation, and proposed treatment of the remaining unpaid portion.

**FR-PART-003 — Creditor accept/reject/counteroffer.** The creditor may accept, reject, or
counteroffer a partial-payment request.

**FR-PART-004 — No implied settlement.** Acceptance of a partial payment never automatically
constitutes full settlement; the remaining balance stays due unless expressly forgiven via the
Settlement flow.

## SETL — Settlements (Spec §12)

**FR-SETL-001 — Structured settlement terms.** A settlement must state pre-settlement balance,
settlement amount, amount forgiven, settlement deadline, whether payment is one-time or scheduled,
and an explicitly chosen failed-settlement consequence (original balance restored / a specific
stated balance restored / a stated amount permanently forgiven / prior agreement remains
controlling pending renegotiation).
- AC1: A settlement cannot be finalized without one of the four listed failure consequences being
  explicitly selected — no implicit default.

**FR-SETL-002 — Settlement requires signed amendment from both parties.**

**FR-SETL-003 — Distinct "Settled in full" status.** A successfully completed settlement sets
agreement status to Settled in full, which is tracked as distinct from Paid in full.

**FR-SETL-004 — Automatic failure-consequence application.** If a settlement is not completed by its
deadline, the system applies the pre-agreed failure consequence without requiring a new negotiation
to restore or confirm the fallback state.

## DISP — Disputes (Spec §13)

**FR-DISP-001 — Either party may dispute.** Either party may dispute the debt's existence, amount,
evidence, payment status, or agreement administration.

**FR-DISP-002 — Structured dispute submission.** The disputing party provides a written explanation,
dispute category, and supporting evidence where available; the other party may respond with their
own evidence.

**FR-DISP-003 — Disputed status with continued collections by default.** Agreement status becomes
Disputed; scheduled payments continue unless the borrower revokes authorization, both parties agree
to a pause, or the processor/administrator imposes a restriction.

**FR-DISP-004 — Platform does not adjudicate.** The platform records and routes the dispute but does
not itself determine which party is legally correct.

**FR-DISP-005 — Amendment required for resolution.** Any resolution that changes balance or schedule
requires a signed amendment, following the same rule as any other term change.

**FR-DISP-006 — Evidence export.** Either party can export a complete evidence package for the
disputed agreement at any time.

## UPAY — Unauthorized-payment disputes (Spec §14)

**FR-UPAY-001 — Payment-level dispute marking.** A borrower's claim that a specific ACH debit or
debit-card charge was unauthorized marks that specific payment (not necessarily the whole
agreement) as Disputed, and notifies both parties.

**FR-UPAY-002 — Fund freeze where permitted.** Recoverable unsettled funds tied to the disputed
payment are frozen where the processor's capabilities permit it.

**FR-UPAY-003 — Evidence preservation and submission.** The system preserves the signed agreement,
the payment authorization mandate, identity-verification results, and timestamps/IP/device/consent
events, and submits appropriate evidence to the processor.

**FR-UPAY-004 — No independent fault determination.** The platform does not independently declare
either party correct; resolution is left to the processor and banking system.

**FR-UPAY-005 — Reversal reduces paid balance.** A reversed payment reduces the agreement's recorded
paid balance unless both parties later agree otherwise.

**FR-UPAY-006 — Separation from underlying debt dispute.** A payment-level unauthorized-charge
dispute and an agreement-level debt dispute (FR-DISP) are tracked as independent records even when
related to the same installment.

## EVID — Evidence & documents (Spec §15)

**FR-EVID-001 — Pre- and post-signing uploads.** Either party may upload supporting evidence before
signing; either party may continue uploading evidence after signing.

**FR-EVID-002 — Post-signing evidence labeling and immutability of the original.** Every post-signing
upload is labeled "Added after agreement signing," is timestamped, triggers a counterparty
notification, does not alter or retroactively join the original signed contract, may itself be
disputed, and cannot be altered by the other party or presented as pre-existing the signing.

**FR-EVID-003 — Bilateral evidence visibility.** Evidence supporting the debt (invoice, receipt,
contract, estimate, purchase order, proof of delivery/completion, prior payment record) is shared
with both parties to the agreement.

**FR-EVID-004 — Sensitive data stays private.** Government ID, bank credentials, complete
account/card numbers, identity-verification documents, and unrelated internal business documents
are never exposed to the counterparty or to witnesses.

**FR-EVID-005 — Witness document restriction.** Witnesses can only see documents explicitly shared
with them, and never banking or identity documents, consistent with FR-WIT-002.

## WIT — Witnesses (Spec §16)

**FR-WIT-001 — Optional, capped at two.** An agreement may include zero, one, or two witnesses.

**FR-WIT-002 — Permitted and prohibited witness actions.** Witnesses may review the agreement,
review explicitly shared documents, confirm they witnessed acknowledgment/signing, and
electronically attest. Witnesses may not change terms, approve amendments, access payment
credentials, access government ID, receive funds, or control the agreement.

**FR-WIT-003 — Permanent, version-bound attestation.** A witness attestation attaches permanently to
the specific agreement version witnessed and is never implied to apply to a later amended version.

**FR-WIT-004 — No silent attestation carry-over.** An amended agreement may request fresh witness
attestations, but the system never auto-applies a prior version's witness attestation to the new
version.

## IDV — Identity verification (Spec §17)

**FR-IDV-001 — Tiered verification.** Basic signup requires verified email, verified phone,
password/passkey, and a basic profile; signing, receiving money, or activating payments requires
Full verification (legal name, DOB, residential address, government ID, selfie/liveness, bank
ownership, payment-provider approval).

**FR-IDV-002 — Business verification tier.** Business profiles additionally require legal business
name, entity type, EIN/SSN as applicable, business address, authorized representative, beneficial
owner information where required, a verified business bank account, and payment-provider business
verification.

**FR-IDV-003 — Age gate.** All users must be 18 or older; underage users are blocked from account
activation.

**FR-IDV-004 — Verification failure blocks activation.** A failed identity or business verification
blocks the specific gated action (signing, receiving funds, activating payments) without deleting
existing account data.

## PROF — Personal & business profiles (Spec §18)

**FR-PROF-001 — Profile composition per login.** One login may contain one personal profile and
multiple separately verified business profiles.

**FR-PROF-002 — Per-profile data isolation.** Each profile maintains separate bank accounts,
agreements, pricing, records, payment routing, reporting, staff access, and audit data.

**FR-PROF-003 — Per-agreement roles.** A single user may be borrower on one agreement and creditor
on another; role is determined per agreement, not fixed to the identity.

**FR-PROF-004 — Business-activity classification.** Any agreement whose proceeds are deposited into
a declared or verified business bank account is treated as business activity, using a combination
of user declaration, identity/business verification, account-ownership matching, and internal risk
review — not automated account-type detection alone.
- AC1: A commercial transaction is treated as business activity even if the business owner attempts
  to route proceeds through a personal profile.

## B2B — Business-to-business (Spec §18A)

**FR-B2B-001 — Dual business verification.** Both parties to a B2B agreement act through separately
verified business profiles that have each completed business identity verification (FR-IDV-002).

**FR-B2B-002 — Authorized representative validation.** Each business designates an authorized
representative, and the system verifies that representative's permission to
create/negotiate/approve/sign/amend/settle/manage the specific agreement before allowing that action.

**FR-B2B-003 — Signer and business identity capture.** The agreement records each business's legal
name and the signer's name, title, role, and authority.

**FR-B2B-004 — Creditor-business payout routing.** Funds are deposited into the creditor business's
verified business bank account; business pricing applies to the creditor business, with the pricing
model configurable when both businesses are charged for premium functionality.

**FR-B2B-005 — B2B CSV drafts with individual activation.** CSV imports may create draft B2B
agreements in bulk, but no imported agreement activates until the debtor business individually
reviews, acknowledges, and signs it (see FR-CSV-003).

**FR-B2B-006 — Staff-permission gating on B2B actions.** Business staff permissions (FR-STAFF)
govern who may create, approve, amend, settle, export, and close B2B agreements, with high-value
B2B agreements able to require two-person or owner approval per configurable business rules.

**FR-B2B-007 — Per-business audit separation.** The system maintains separate audit records for
actions taken by each business and each of its authorized employees on a shared B2B agreement.

**FR-B2B-008 — No interest/time-based charges in B2B.** B2B agreements are subject to the same
prohibition on interest, percentage-based late fees, compounding charges, and time-based finance
charges as personal agreements (§2).

**FR-B2B-009 — Representative-change does not invalidate signed agreement.** Changing a business's
authorized representative never alters or invalidates an already-signed agreement.

**FR-B2B-010 — B2B dashboards.** Business debtor and business creditor dashboards expose accounts
payable, accounts receivable, upcoming payments, overdue installments, settlements, disputes, and
exports.

## PRICE — Pricing (Spec §19)

**FR-PRICE-001 — Free access to the app.** The application is free to download and access.

**FR-PRICE-002 — Non-dollar free-tier threshold.** The personal free-plan limit is based on number
of agreements and number of included successful payments — never on total dollar amount as the
primary threshold.

**FR-PRICE-003 — Configurable pricing tables.** All prices and allowances are stored in
configurable pricing tables; no speculative price is hard-coded into application logic.

**FR-PRICE-004 — Business pricing components.** Business profiles are charged a standard annual fee,
a small transaction fee, and processing costs per the signed fee allocation; each separately
verified business profile may carry its own subscription.

**FR-PRICE-005 — No forced termination for exceeding free tier.** An existing active agreement is
never terminated solely because a personal user has exceeded a free-tier allowance.

**FR-PRICE-006 — Prospective-only pricing changes.** Pricing changes apply prospectively and never
rewrite the fee terms of an already-signed agreement.

## STAFF — Business staff & permissions (Spec §20)

**FR-STAFF-001 — Individual staff logins.** Business owners invite staff members under individual
logins; shared credentials are not permitted.

**FR-STAFF-002 — Role-based and granular permissions.** The system supports role-based permission
sets (Owner/Admin, Manager, Receivables staff, Accountant/Viewer, Custom role) plus granular,
owner-configurable controls (who can create agreements, send invitations, propose amendments,
approve hardship requests; maximum settlement discount; maximum principal reduction; maximum
payment-date change; maximum partial-payment variance; two-person/owner-approval thresholds; who can
export, change schedules, or view reports).

**FR-STAFF-003 — Elevated authentication for sensitive staff/business changes.** Bank-account
changes, beneficial-owner changes, owner changes, significant settlements, staff-permission changes,
and payout changes require elevated authentication and authorization (ties to FR-MFA-001).

**FR-STAFF-004 — Attributable staff actions.** Every staff action records the acting employee and
the business profile under which it was taken.

**FR-STAFF-005 — Immediate, non-destructive access removal.** Removing a staff member's access takes
effect immediately and never deletes that staff member's historical audit trail.

## CSV — Bulk imports & integrations (Spec §21)

**FR-CSV-001 — Supported import types.** CSV upload supports customers, invoices, balances, and
proposed payment plans.

**FR-CSV-002 — Import validation pipeline.** Every import runs through validation, a preview,
duplicate detection, and produces an error report with per-row rejection reasons.

**FR-CSV-003 — Draft-only bulk creation.** A bulk import can only create draft agreements; a business
can never bulk-activate agreements, and each borrower must individually authenticate, review,
acknowledge, and sign (ties to FR-B2B-005).

**FR-CSV-004 — Integration abstraction layer.** The system is designed with an integration
abstraction layer capable of supporting future connectors (QuickBooks Online, Xero, FreshBooks,
Square, Shopify, others) without requiring those specific integrations in the MVP.

## INV — Invitations (Spec §22)

**FR-INV-001 — Multi-channel secure link delivery.** Agreement invitations are shared via secure
link over email, SMS, WhatsApp, or another messaging application.

**FR-INV-002 — Link properties.** Every invitation link expires, is revocable, becomes single-use
after acceptance, reveals no sensitive debt detail before authentication, requires account
creation/login, requires identity verification before signing, and binds to the intended phone
number or email where available.

**FR-INV-003 — Full invitation event log.** The system records link creation, delivery, open,
acceptance, expiration, and revocation events.

**FR-INV-004 — Forwarded-link protection.** A link forwarded to an unintended recipient cannot be
used to accept the agreement (enforced via the phone/email binding in FR-INV-002).

## NOTIF — Notifications (Spec §23)

**FR-NOTIF-001 — Multi-channel notification support.** The system supports email, SMS, and in-app
notifications.

**FR-NOTIF-002 — Non-disableable critical notifications.** The following events always generate a
notification the user cannot turn off: agreement signing, amendment, payment scheduled, payment
processing, payment cleared, payment failed, payment disputed, bank-account change, debit-card
change, ACH authorization revocation, hardship request, partial-payment request, settlement request,
security event, staff-permission change, payout-account change, and account restriction.

**FR-NOTIF-003 — User-controllable reminders.** Users may enable/disable noncritical reminder
notifications independent of the critical set above.

**FR-NOTIF-004 — Email-only support channel in MVP.** Customer support is provided via email only in
the MVP; live chat and telephone support are out of scope.

## COMM — Internal communication (Spec §24)

**FR-COMM-001 — No unrestricted in-app chat in MVP.** The MVP does not include a general-purpose,
unrestricted messaging/chat system between users.

**FR-COMM-002 — Structured messaging deferred.** Agreement-specific structured messaging (hardship,
amendments, disputes, settlement requests, document notices, payment issues) is explicitly a
post-MVP feature, not built in this phase.

## CREDIT — Credit reporting (Spec §25)

**FR-CREDIT-001 — Not activated in MVP.** No credit-bureau reporting functionality is enabled or
exposed to users in the MVP.

**FR-CREDIT-002 — Forward-compatible data model.** The data model reserves the fields/flags needed to
later support optional, opt-in, positive-only-payment credit reporting without a breaking schema
change (implementation detail carried to Deliverable 7).

## MFA — Multifactor authentication (Spec §26)

**FR-MFA-001 — MFA required for sensitive actions.** MFA is required before: signing an agreement,
changing a bank account, changing a debit card, changing payout details, approving a settlement,
forgiving debt, changing staff permissions, changing business-ownership data, exporting sensitive
records, closing an account, and resetting security credentials.

**FR-MFA-002 — Method preference order.** Passkeys, authenticator apps, and hardware-backed methods
are preferred; SMS is available only as a fallback, never as the sole/preferred high-assurance
method.

## SIG — Electronic signatures (Spec §27)

**FR-SIG-001 — Full signature-event capture.** Every signature captures consent, identity
attribution, signer name, signer role, date/time, timezone, IP address, device information,
document version, agreement hash, consent events, authentication method, payment authorization,
witness attestations (if any), and an audit-log entry.

**FR-SIG-002 — Downloadable PDF with complete terms.** Both parties receive a downloadable PDF
showing all financial terms, fees, signatures, version history, and payment authorization.

**FR-SIG-003 — Tamper-evident, immutable versioning.** Signed documents use tamper-evident hashing
and immutable version history; a drawn-signature image placed on an otherwise-editable document does
not satisfy this requirement.

## RET — Data retention (Spec §28)

**FR-RET-001 — Seven-year baseline retention.** Completed agreements, payment records, signatures,
evidence, and audit logs are retained for seven years after agreement closure.

**FR-RET-002 — Retention-extension triggers.** Retention extends automatically for an active
dispute, fraud investigation, litigation hold, subpoena, payment-provider requirement, or other
legal/regulatory requirement affecting that record.

**FR-RET-003 — Deletion respects legal holds.** Account deletion requests never erase records that
must legally or operationally be retained; unrelated personal data is minimized or deleted where
legally permitted.

## ADMIN — Administration (Spec §29)

**FR-ADMIN-001 — Administrative dashboard capabilities.** Authorized administrators can suspend
accounts, restrict payments, pause new-agreement creation, review identity-verification status,
review fraud alerts, review payment failures, review disputes, review audit logs, restrict payouts
where permitted, manage support cases, and export records for authorized legal requests.

**FR-ADMIN-002 — Administrative prohibitions.** Administrators cannot alter a signed agreement,
fabricate consent, rewrite payment history, delete an audit event, change a balance outside an
authorized traceable adjustment process, or sign on behalf of a user.

**FR-ADMIN-003 — Fully attributed administrative actions.** Every administrative action records
administrator identity, role, timestamp, reason, before/after values, authorization level, and case
reference.

## APPEAL — Appeals (Spec §30)

**FR-APPEAL-001 — Appealable actions.** Users may appeal account suspension, fraud restriction,
payout hold, or administrative restriction.

**FR-APPEAL-002 — Structured appeal process.** The appeal process assigns a case number, records the
original restriction, accepts supporting evidence, ensures the original decision-maker is not the
sole reviewer, preserves reviewer notes, records the decision and rationale, and notifies the user
by email.

**FR-APPEAL-003 — Restriction persists during review.** The original restriction remains in place
throughout the appeal review unless an authorized reviewer affirmatively lifts it.

## FRAUD — Fraud and risk management (Spec §31)

**FR-FRAUD-001 — Dual detection layer.** Fraud/risk detection combines payment-processor fraud tools
with internal risk rules.

**FR-FRAUD-002 — Defined risk patterns.** The system flags patterns including duplicate identities,
shared bank accounts across unrelated users, shared devices across suspicious accounts, rapid
agreement creation, repeated high-value agreements, frequent payment failures, chargebacks/ACH
returns, frequent bank-account changes, abnormal settlement discounts, unusual payout changes,
business activity routed through personal profiles, repeated invitations to unverifiable recipients,
multiple accounts controlled by one actor, circular payment activity, self-payments, collusive
agreements, and account-takeover indicators.

**FR-FRAUD-003 — Graduated response set.** Available responses are additional verification, manual
review, temporary payment restriction, payout hold, agreement-creation restriction, and account
suspension.

**FR-FRAUD-004 — No automatic agreement erasure; documented permanence.** Risk rules never
automatically erase an agreement; any permanent restriction requires documented review beyond the
initial flag.

## AUDIT — Administrative and audit integrity (Spec §32)

**FR-AUDIT-001 — Append-only audit architecture.** All audit events are recorded in an append-only
store, not an ordinary editable application log.

**FR-AUDIT-002 — Full audit event fields.** Each audit event records actor, role, profile,
agreement, action, timestamp, IP address, device, previous value, new value, reason, authentication
strength, related document, and related support/compliance case where applicable.

**FR-AUDIT-003 — Tamper-resistance mechanisms.** The architecture proposes event hashing, immutable
storage, and access restriction sufficient to resist tampering (mechanism detailed in Deliverable 6
and Deliverable 10).

## MONEY — Cross-cutting payment-integrity rules (Spec §37)

**FR-MONEY-001 — No floating-point money.** All monetary values are represented as integer minor
units (e.g., cents) or fixed-precision decimal types; floating-point types are never used for money
anywhere in the system.

**FR-MONEY-002 — Idempotent payment processing.** Every payment-initiating operation carries an
idempotency key so retried requests (client retries, network failures) never produce duplicate
charges or duplicate payouts.

**FR-MONEY-003 — Verified webhook trust boundary.** Payment-provider webhooks are never treated as
trustworthy until their signature is verified and the event is deduplicated/idempotency-checked.

---

**Coverage note:** These requirements implement Sections 3–32 and the cross-cutting rule in Section
37; Sections 1–2 (product concept, ethical positioning) and Section 33–36 (technical stack,
accessibility, MVP boundaries, deliverable structure) are addressed by Deliverable 1 and by
Deliverables 5–15 rather than as standalone functional requirements here, since they are
nonfunctional, architectural, or process in nature.

*Next phase: Deliverable 5 — Nonfunctional requirements.*
