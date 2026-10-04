# First Live Business Acceptance Plan

"PAID2YOU — MASTER P0" (2026-10-03), Section 64. The owner's Day 4-5 controlled test, run against
the real deployed production environment with real Middesk/Stripe/Resend/Supabase configuration —
never against this repository's own automated test suites, which already separately prove the code
paths below in isolation (see `docs/CODEX_P0_VERIFICATION_HANDOFF.md`).

**This plan does NOT include a customer repayment transaction.** Direct Banking (the only approved
repayment rail) is not implemented in this worktree — Payments must stay hidden/unavailable
throughout this test, by design.

## Sequence

1. Authenticate as a real test user (a Personal account the owner controls).
2. Create a Business organization (`POST /api/organizations` via the onboarding UI).
3. Enter real Business information (legal name, entity type, Tax ID/EIN, formation jurisdiction,
   address, authorized representative).
4. Accept the current governing documents (Terms, Business Subscription Policy, Recurring Payment
   Authorization) — confirm the exact versions shown match `CURRENT_LEGAL_DOCUMENT_VERSIONS`.
5. Submit Middesk verification with the real business's real EIN.
   - Confirm this application's own logs/database never contain the raw EIN — only `tax_id_last4`
     (see `business_verification` table).
6. Receive a legitimate verification result from Middesk (via the real webhook, or by polling if the
   webhook has not yet fired) — `open`/`pending` → eventually `approved` (mapped to `verified`) or
   `in_review` (a human must resolve this in Middesk's own dashboard before continuing).
7. Select the Starter plan ($99/month, 0-24 established arrangements).
8. Complete Stripe-hosted billing setup — a real test payment method (Stripe test-mode card, or a
   real card if this is a genuinely live account) via the hosted component, never typed into this
   application's own UI.
9. Receive a legitimate subscription confirmation — confirm the subscription shows `active` only
   after Stripe's own webhook (or the synchronous `startSubscription` response) confirms it, never
   merely because the HTTP call to this application returned 200.
10. Confirm the Business becomes ACTIVE (`BusinessActivationService.computeActivationStatus`) — all
    four independent facts (onboarding complete, verification verified, subscription active, legal
    acceptance complete) must be true.
11. Enter the Business workspace.
12. Confirm the plan shown is Starter.
13. Confirm usage shows `0 of 24`.
14. Invite a controlled employee using a real email address the owner controls.
15. Confirm the invitation email actually arrives via Resend (not a console-only log) — check the
    sending domain's verified status if it does not arrive promptly.
16. Accept the invitation as that employee.
17. Verify the employee was assigned the intended role (and only the permissions that role grants).
18. Create a customer (a test counterparty).
19. Create an outstanding balance/obligation for that customer.
20. Create an agreement referencing that balance.
21. Complete the normal agreement signing flow (both parties).
22. Confirm the arrangement is now "established" per the existing canonical signing transition.
23. Confirm usage becomes `1 of 24` — never 2, even if any step above was retried.
24. Open the Billing & Subscription page and confirm:
    - the real subscription state (active, current period dates) is shown;
    - the real Stripe invoice (if one has been generated) is shown, not fabricated;
    - the payment method's safe display metadata (type, last4) matches what was actually attached.
25. Create a SECOND test organization (a different owner, or the same owner's second Business) and
    confirm it cannot see the first organization's customers, balances, agreements, or billing data
    through this application — this is the single most important check in this entire plan. Any
    failure here is an immediate stop-launch condition (see the runbook's own Section 20/65).
26. Confirm Payments remains hidden from the organization's navigation.
27. Confirm there is no reachable action anywhere in the UI that would initiate a customer repayment
    transaction — repayment money movement must remain structurally unavailable, not merely hidden
    behind a flag that could be flipped by accident.
28. (Optional, only if steps 1-24 all succeeded cleanly) Test cancel-at-period-end: cancel the
    subscription, confirm it still shows active with `cancelAtPeriodEnd: true` and retains workspace
    access until the period actually ends.
29. (Optional, only following step 28) Test reactivate: confirm the cancellation can be reversed
    before the period ends.

## What "pass" means

Every step above completes exactly as described, with no step requiring a workaround, a direct
database edit, or a "trust me, it probably worked" judgment call. A failure at any step should be
diagnosed and fixed (or explicitly accepted as a known, documented limitation — e.g. the nonpayment
→ suspension gap already flagged in `docs/PRODUCTION_LEGAL_REVIEW.md`) before inviting a second real
Business onto the platform.

## What this plan deliberately does not test

- Any FedNow/RTP/Request for Payment capability — none exists in this worktree.
- A real customer-to-customer repayment transaction — same reason.
- Enterprise self-service checkout — structurally impossible by design (Section 21), not something
  to "test until it works."
- Downgrade — structurally hidden by design (Section 31), not something to "test until it works."
