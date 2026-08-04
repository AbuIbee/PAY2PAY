# Deliverable 3: Complete User Journeys

Source: `docs/PAY2PAY_MASTER_SPEC.md`, primarily Sections 3–17, 18A, 20–23, 26–31. Each journey
below is the exact item named in Section 36, Deliverable 3, mapped step by step. Agreement states
referenced are those enumerated in Section 5; payment states are those enumerated in Section 7.

## 1. Personal debt agreement (golden path)

1. Initiator (either party) signs up or logs in with Basic verification (email, phone, password/passkey).
2. Initiator starts a draft agreement, selects "personal" type, and identifies the other party by
   email or phone for a secure invitation (Section 22).
3. Initiator enters the required agreement information (Section 4): debt category, plain-language
   description, original amount, prior payments, remaining balance, optional supporting evidence,
   payment method, first-payment amount, remaining installment schedule/frequency, first and final
   scheduled payment, fee allocation, early-payment/hardship/partial-payment/settlement terms,
   dispute procedure.
4. System computes and displays total acknowledged debt, first payment, remaining principal,
   installment count and amounts, frequency, final payment (including any rounding adjustment)
   (Section 5). Agreement status: **Draft**.
5. Secure, expiring, single-use, revocable invitation link sent to the other party; link reveals no
   debt details before authentication and binds to the intended phone/email (Section 22).
6. Other party opens the link, creates an account or logs in (Basic verification).
7. If the recipient of the link is the **borrower**, they must complete **Full personal
   verification** (Section 17) before acknowledging the debt. Status: **Awaiting payer
   acknowledgment**.
8. Borrower reviews and formally acknowledges: that the debt exists, its reason, amount, prior
   payments, remaining balance, terms, and payment authorization (Section 3).
9. Status moves to **Awaiting recipient acceptance**; the creditor reviews and accepts the terms,
   completing Full verification if not already done.
10. Status moves to **Awaiting signatures**. A final review screen is shown to both parties
    summarizing what's owed, why, first/later payments, dates, fees, payment method, total borrower
    outflow, net recipient proceeds, cancellation rules, ACH revocation rights, amendment rules, and
    dispute process (Section 34).
11. Both parties electronically sign under MFA (Section 26, Section 27), with consent, identity
    attribution, timestamp, timezone, IP, device, document hash, and authentication method captured.
12. Status becomes **Signed**; the agreement locks and the original signed version is preserved
    immutably. Both parties receive a downloadable, tamper-evident PDF (Section 27).
13. Status becomes **First payment pending**; the mandatory first payment is collected via ACH or
    debit card (Section 5, Section 6).
14. First payment moves through the payment state machine (Scheduled → Submitted → Processing →
    Cleared) and, once cleared, is routed to the creditor via the processor (Payout pending → Paid
    out) (Section 7).
15. Status becomes **Active**; the recurring installment schedule begins and each installment
    follows the same payment-processing/payout flow as it comes due.
16. Agreement remains **Active** until all installments clear, at which point it becomes **Paid in
    full** → **Closed** — or it diverts into the Past due, Disputed, Paused-by-amendment, or
    Settled-in-full paths described in the journeys below.

## 2. Business invoice payment plan

1. A verified **business profile** (Section 17, Section 18) initiates the draft as creditor for an
   already-completed sale or service.
2. Agreement information includes the same required fields as Journey 1, plus legitimate original
   invoice components where applicable: product/service price, sales tax, shipping/delivery,
   installation, permit/filing costs (Section 4) — never charges added solely for paying over time.
3. Invitation sent to the payer (consumer or another business) per the standard invitation flow
   (Section 22).
4. Payer authenticates, and if a business, completes business verification (Section 17); if a
   consumer, completes Full personal verification before signing.
5. Steps 8–16 of Journey 1 proceed identically (acknowledgment → acceptance → signatures → first
   payment → active schedule), with one difference: payouts route to the business's **verified
   business bank account** (Section 18A), and business pricing (annual fee, per-transaction fee,
   disclosed processing cost per the signed fee allocation) applies (Section 19).

## 3. Borrower-initiated proposal

1. The person who owes money starts the draft, entering the debt facts and proposing terms
   (Section 3 permits either party to initiate).
2. Because the initiator is also the borrower, their own acknowledgment (Section 3, item 8 of
   Journey 1) is captured at draft creation rather than after an invitation round-trip.
3. Invitation sent to the creditor (Section 22).
4. Creditor authenticates, reviews the proposed terms, and either accepts (proceeds to Journey 1
   step 10 onward) or the parties renegotiate terms before signatures (still pre-signature, so no
   amendment process is needed yet — the draft is simply edited and re-sent for review).
5. Once accepted, the flow rejoins Journey 1 at signatures.

## 4. Creditor-initiated proposal

1. The person owed money starts the draft and proposes terms (Section 3).
2. Invitation sent to the borrower (Section 22).
3. Borrower authenticates and completes Full verification if required.
4. Regardless of who authored the draft, the **borrower must still formally acknowledge** the debt's
   existence, reason, amount, prior payments, remaining balance, terms, and payment authorization
   (Section 3) — creditor-authored terms are not binding on the borrower until acknowledged.
5. Flow rejoins Journey 1 at acceptance → signatures.

## 5. First payment

1. Immediately after both signatures, status becomes **First payment pending** (Section 5); a
   signed agreement remains valid even before this payment succeeds.
2. Borrower is prompted to complete the first payment (any mutually agreed amount, not required to
   equal the recurring installment) via ACH or debit card.
3. **Success path**: payment clears (Scheduled → Submitted → Processing → Cleared → Payout
   pending → Paid out); status becomes **Active**; the recurring schedule activates.
4. **Failure path**: the payment fails; the signed debt acknowledgment is **not** erased, but the
   automated repayment schedule does not fully activate (Section 5) until resolved — this hands off
   to the Failed-payment journey below, applied to the first installment specifically.

## 6. Failed payment

1. A scheduled installment (or the first payment) fails to clear.
2. Both parties are notified immediately with a non-sensitive failure category (Section 8) — no raw
   processor decline codes exposed.
3. Borrower may make a manual payment at any time after the failure.
4. System schedules exactly one automatic retry after a configurable delay (default recommendation:
   three business days).
5. If the borrower pays manually before the retry fires, the scheduled retry is canceled.
6. If the automatic retry also fails, all automatic attempts for that installment stop — no
   repeated uncontrolled retries, and no automatic late fee is applied (Section 8).
7. Borrower may request a new date for the unpaid installment; this requires **recipient approval**
   before it becomes a formal reschedule (i.e., it is not unilateral).
8. The unpaid installment record is preserved in agreement history regardless of eventual outcome.

## 7. Retry

1. Triggered automatically once, per failed installment, after the configured delay (Section 8),
   unless canceled by an intervening manual payment (Journey 6, step 5).
2. Processor re-attempts the charge against the same payment method.
3. **Success**: payment state moves Processing → Cleared → Payout pending → Paid out; the
   installment is marked paid; no further action needed.
4. **Failure**: payment state moves to Failed a second time; automatic retries stop for this
   installment (Section 8); borrower is left with the manual-payment and reschedule-request options
   from Journey 6.

## 8. Hardship request

1. Borrower submits a hardship request specifying: reason, requested relief (new date, temporary
   pause, reduced installments, or revised schedule), proposed effective date, and proposed
   replacement terms (Section 9).
2. Creditor is notified (critical notification, Section 23) and may **accept**, **reject**, or
   **counteroffer**.
3. The existing signed agreement remains fully controlling throughout negotiation — no term changes
   take effect from the request alone.
4. If the creditor accepts (or a counteroffer is mutually agreed), both parties sign a formal
   **amendment**: a new version is created, the original signed terms are preserved unmodified
   underneath it (Section 3, Section 9).
5. No interest, balance growth, or penalty may be introduced as part of a hardship amendment
   (Section 9).
6. If rejected, the original schedule remains controlling and the agreement continues under its
   existing terms (e.g., proceeding into the Failed-payment/Past-due path if installments are missed).

## 9. Partial payment

1. Partial payments require **creditor pre-approval** — a borrower cannot simply submit a smaller
   amount unilaterally (Section 11).
2. Borrower submits: proposed partial amount, proposed date, optional explanation, and proposed
   treatment of the remaining unpaid portion of that installment.
3. Creditor **accepts**, **rejects**, or **counteroffers**.
4. If accepted, the partial payment is processed through the normal payment state machine.
5. The remaining balance stays due unless the creditor **expressly** forgives it — acceptance of the
   partial amount does not itself constitute settlement (Section 11); any forgiveness requires the
   Settlement journey's formal terms.

## 10. Extra payment

1. Borrower makes an additional principal payment (beyond the scheduled installment) at any time,
   without penalty (Section 10).
2. If the extra payment **does not** fully pay off the balance, borrower proposes one of two
   treatments: (a) keep the current installment amount and finish the schedule sooner, or (b)
   reduce future installment amounts while preserving the original final date.
3. Either treatment requires **creditor approval** and results in a signed schedule amendment
   (consistent with Section 3's amendment rules).
4. If the extra payment **does** fully pay off the remaining balance, the flow proceeds directly to
   the Full payoff journey below instead.

## 11. Full payoff

1. Borrower pays (via a single extra payment or the natural conclusion of the schedule) an amount
   that brings the remaining balance to zero.
2. The final payment clears through the standard payment state machine.
3. On confirmed clearing, the system automatically closes the agreement as **Paid in full**
   (Section 10, Section 5) — no manual creditor action is required to trigger this status.
4. No further installments are scheduled; both parties retain access to the full signed history and
   payment records (subject to the seven-year retention model, Section 28).

## 12. Settlement

1. Creditor and borrower mutually negotiate a settlement for less than the full remaining balance
   (Section 12).
2. The settlement terms must state: pre-settlement balance, settlement amount, amount forgiven,
   settlement deadline, whether payment is one-time or scheduled, and the **explicitly chosen**
   consequence if the settlement is not completed (original balance restored / a specific stated
   balance restored / a stated amount permanently forgiven / the prior agreement remains
   controlling pending renegotiation).
3. Both parties sign the settlement as a formal amendment; the original agreement terms remain
   preserved underneath it.
4. Settlement payment(s) process through the standard payment state machine.
5. **On successful completion**, status becomes **Settled in full** — explicitly distinct from
   **Paid in full** (Section 12).
6. **On failed completion** (deadline passed without full settlement payment), the pre-agreed
   failure consequence from step 2 is applied automatically per its terms.

## 13. Dispute

1. Either party disputes the debt's existence, amount, evidence, payment status, or agreement
   administration (Section 13).
2. Disputing party submits a written explanation, a dispute category, and supporting evidence where
   available.
3. The other party is notified and may respond with their own evidence.
4. Agreement status becomes **Disputed**.
5. Scheduled payments **continue** through this status unless the borrower revokes payment
   authorization, both parties agree to a pause, or the payment processor/administrator imposes a
   restriction (Section 13) — dispute status alone does not halt collections.
6. The platform does **not** rule on the underlying dispute; it hosts the evidence exchange.
7. Any resolution that changes balance or schedule requires a signed amendment, same as any other
   term change.
8. Either party may export a complete evidence package at any time during or after the dispute.

## 14. Unauthorized-payment claim

1. Borrower claims a specific ACH debit or debit-card charge was unauthorized (Section 14) — this is
   distinct from disputing the underlying debt.
2. That specific payment is marked **Disputed** (payment-level state, Section 7).
3. Both parties are notified.
4. Recoverable unsettled funds are frozen where the processor permits.
5. The system preserves: the signed agreement, the payment authorization mandate, identity
   verification results, and timestamps/IP/device/consent events tied to that authorization.
6. Appropriate evidence is submitted to the payment processor.
7. The processor and banking system resolve the payment dispute — the platform does not
   independently declare either party correct.
8. If the payment is reversed, the agreement's paid balance is reduced accordingly, unless both
   parties later agree otherwise.
9. The payment-level dispute and the underlying debt dispute (Journey 13) are tracked as separate
   concepts even if they arise from the same installment.

## 15. Witness attestation

1. During draft creation (or later, per Section 16), either party invites up to two witnesses.
2. Witness receives an invitation and authenticates to the platform.
3. Witness reviews the agreement and only the supporting documents that have been **explicitly
   shared** with them — never banking or identity documents (Section 15, Section 16).
4. Witness confirms they witnessed the acknowledgment or signing and **electronically attests**.
5. The attestation attaches **permanently** to the specific agreement version witnessed.
6. If the agreement is later amended, the amendment may separately request new witness
   attestations — a prior witness's attestation is never silently carried forward onto the new
   version (Section 16).

## 16. Business CSV import

1. A verified business uploads a CSV of customers, invoices, balances, or proposed payment plans
   (Section 21).
2. System validates the file, shows a preview, flags likely duplicates, and produces an error report
   with per-row rejection reasons.
3. Business reviews the preview and confirms bulk **draft** creation — the import can only create
   drafts, never active agreements.
4. Each resulting draft agreement then follows the standard Creditor-initiated proposal journey
   (Journey 4) individually: its own borrower invitation, authentication, Full verification (if
   required), acknowledgment, and signature.
5. No imported agreement becomes active until its specific borrower has individually completed that
   full review-and-sign flow (Section 21) — bulk activation is explicitly prohibited.

## 17. Staff approval

1. A business staff member (e.g., Receivables staff or Business manager) proposes an action that
   exceeds their owner-configured authority — e.g., a settlement discount above their cap, a
   principal reduction above their cap, or any action flagged for mandatory two-person or
   owner-level approval (Section 20).
2. The action is queued rather than executed immediately.
3. The designated approver (a second authorized staff member, a manager, or the owner, depending on
   the configured rule) reviews the proposed action.
4. Approver **approves** or **rejects**; if approved, the underlying agreement action (amendment,
   settlement, hardship acceptance, etc.) proceeds through its normal signed-amendment flow.
5. The audit log records both the proposing staff member and the approving staff member, each
   identified by employee and business profile (Section 20).

## 18. Account restriction

1. Internal risk rules or payment-processor fraud tooling flag a pattern (Section 31) — e.g.,
   repeated payment failures, shared bank accounts across unrelated users, rapid agreement creation,
   abnormal settlement discounts, or business activity routed through a personal profile.
2. A platform administrator or automated risk rule applies one of the defined responses: additional
   verification requirement, manual review, temporary payment restriction, payout hold,
   agreement-creation restriction, or account suspension (Section 31).
3. Affected user(s) receive a critical, non-disableable notification of the account restriction
   (Section 23).
4. The action is logged with administrator identity, role, timestamp, reason, before/after values,
   authorization level, and case reference (Section 29).
5. Existing signed agreements are **not** erased or altered by the restriction (Section 31) — the
   restriction limits future actions (e.g., new agreements, payouts), not historical records.
6. Any restriction intended to be **permanent** requires documented review beyond the initial
   automated or single-administrator flag (Section 31).
7. The restricted user may pursue the Appeal journey below.

## 19. Appeal

1. Restricted or suspended user contacts email support to appeal (Section 30) — the MVP's sole
   appeal channel.
2. A case number is assigned; the original restriction and its stated reason are recorded against
   the case.
3. User submits supporting evidence.
4. The case is reviewed by someone other than the original decision-maker (Section 30) — per the
   role model in Deliverable 2, this is expected to be a **Compliance reviewer**, though the exact
   authority split between that role and Platform administrator remains an open decision (see
   `docs/OPEN_DECISIONS.md`, item 5).
5. Reviewer notes are preserved; the decision and its rationale are recorded.
6. User is notified of the outcome by email.
7. The restriction **remains in place throughout the review** unless an authorized reviewer
   affirmatively lifts it before the decision (Section 30) — an appeal being filed does not itself
   pause the restriction.

---
*Next phase: Deliverable 4 — Functional requirements.*
