# Launch-Critical Email Inventory

"PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 8-H. Enumerates every actual
email-sending call site reachable from the first-live-Business acceptance flow, classified as:

- **PRODUCTION RESEND** — reaches `getEmailSender()` (`src/lib/notify/getEmailSender.ts`), the single
  factory shared by every email call site in this codebase. When `RESEND_API_KEY` +
  `EMAIL_FROM_ADDRESS` + `EMAIL_DELIVERY_ENABLED=true` are configured, this resolves to
  `ResendEmailSender` — a real, production email provider, not a mock. Outside that configuration it
  falls back to `ConsoleEmailSender` (log-only in dev/test; **fails closed** — throws rather than
  silently "succeeding" — when `APP_ENV=production` and the live config is missing).
- **NOT IMPLEMENTED** — no email is sent for this event today; the underlying service has no
  `EmailSender`/`NotificationService` call at all.
- **NOT REQUIRED FOR INITIAL LAUNCH** — deliberately out of scope for a controlled first Business.

There is exactly one production decision point for "is email actually live" — `getEmailSender()` —
so every row marked PRODUCTION RESEND below is equally real; none of them is a separate, weaker path.

## Staff invitations

**PRODUCTION RESEND.** `StaffService.inviteStaffMember` (`src/lib/staff/staffService.ts:256`) calls
`this.emailSender.send(...)` directly — the recipient has no account yet, so this bypasses
`NotificationService` (which requires an existing user with preferences) by design, exactly like
`AgreementInvitationService` below. Wired via `getStaffService.ts` → `getEmailSender()`.

## Agreement invitations

**PRODUCTION RESEND.** `AgreementInvitationService.createInvitation`
(`src/lib/agreementInvitations/agreementInvitationService.ts:299`, plus a resend/reminder path at
line 541) calls `this.deps.emailSender.send(...)`. Also sends SMS (`smsSender.send`, line 308) where
eligible — out of scope for this email-specific inventory.

## Agreement notifications (signed, counterparty signed, decided, amendment, cancellation, etc.)

**PRODUCTION RESEND.** All routed through `NotificationService.notify(...)` →
`NotificationService.deliver()` (`src/lib/notify/notificationService.ts:633`), which calls
`this.deps.emailSender.send(...)` for every `NotificationEventType` whose default channel set
includes `email` (every type in `src/lib/notify/eventTypes.ts` includes `email`). Wired via
`getNotificationService.ts` → `getEmailSender()`. Covers (non-exhaustive):
`agreement_signed`, `agreement_counterparty_signed`, `agreement_decided`, `agreement_action_required`,
`amendment`, `amendment_decided`, `agreement_cancellation_requested`, `agreement_cancellation_decided`,
`payment_scheduled`/`payment_cleared`/`payment_failed`/`payment_disputed` (customer-repayment
lifecycle — a different domain from Paid2You's own subscription billing, see below).

## Authentication / password reset (application-owned)

**PRODUCTION RESEND.** `AuthService.sendVerificationEmail` (`src/lib/auth/authService.ts:487`,
subject "Verify your PAY2PAY email address") and the forgot-password flow
(`src/lib/auth/authService.ts:655`, subject "Reset your PAY2PAY password") both call
`this.emailSender.send(...)` directly, wired via `getAuthService.ts` → `getEmailSender()`.

## Business verification notifications (Middesk submitted / review-required / approved / rejected)

**NOT IMPLEMENTED.** `BusinessVerificationService` (`src/lib/organizations/businessVerificationService.ts`)
records a safe audit event for every status transition (Section 8-B, already closed — see
`PAID2YOU P0 CLOSURE REMEDIATION CHECKPOINT`), but has no `EmailSender`/`NotificationService`
dependency at all and sends no email to the Business when verification is submitted, enters review,
is approved, or is rejected. `NotificationEventType` (`src/lib/notify/eventTypes.ts`) has no
verification-specific value either — this is a genuine gap, not a partially-wired path. For a
controlled first Business the owner/operator already knows the verification outcome first-hand (it is
visible in the onboarding UI's own state — `GET /api/organizations/onboarding/state` — and, for an
`in_review` case, in Middesk's own dashboard per `docs/OWNER_LAUNCH_ACTIONS.md`), so this is a real
but containable gap for Day 4-5, not a launch blocker by itself.

## Billing / subscription notifications (Paid2You's own subscription — started, activated, payment
failed/past due, canceled, reactivated, upgraded)

**NOT IMPLEMENTED.** Neither `PlatformBillingService` nor `PlatformBillingWebhookService`
(`src/lib/organizations/platformBillingService.ts`, `platformBillingWebhookService.ts`) has an
`EmailSender`/`NotificationService` dependency. Section 8-C's audit events (now wired — see the P0
checkpoint) give the organization's Billing & Subscription page and the audit log an accurate record,
but nothing emails the Business when, for example, its first subscription payment fails. The generic
`payment_failed`/`payment_cleared` `NotificationEventType`s exist but are scoped to the CUSTOMER
repayment domain (`src/lib/payments/*`) — a structurally separate system from Paid2You's own
subscription billing (see `platformBillingProvider.ts`'s own doc comment on that separation) — reusing
them here would blur that deliberate domain boundary rather than close this gap correctly. Flagging
as a real, documented gap rather than silently reusing the wrong notification type.

## Onboarding notifications (e.g. "your Business is now active")

**NOT IMPLEMENTED.** `BusinessOnboardingService` has no `EmailSender`/`NotificationService` call at
any step (details, verification, tier, legal, billing). The onboarding wizard's own UI
(`BusinessOnboardingWizard.tsx`) already reflects real server state live (polling
`GET /api/organizations/onboarding/state`), so a controlled first Business watching that page will see
activation happen without needing an email to tell them — this is a nice-to-have, not a blocker, for
Days 4-5.

## Summary

| Category | Status |
|---|---|
| Staff invitations | PRODUCTION RESEND |
| Agreement invitations | PRODUCTION RESEND |
| Agreement notifications (signed/decided/amendment/cancellation/etc.) | PRODUCTION RESEND |
| Authentication / password reset | PRODUCTION RESEND |
| Business verification notifications | NOT IMPLEMENTED |
| Billing/subscription notifications | NOT IMPLEMENTED |
| Onboarding notifications | NOT IMPLEMENTED |

**First-live-Business required emails all Resend-capable?** Partially. Every email that already
exists in this codebase is genuinely production-Resend-capable (there is no second, weaker path) —
staff invitations, agreement invitations, agreement lifecycle notifications, and auth/password-reset
all qualify. Business verification, billing/subscription, and onboarding notifications are real gaps:
no email is sent for any of them today. None of the three gaps blocks a controlled first Business
from completing onboarding or being activated (every one of those states is already visible live in
the product UI and/or the provider's own dashboard), but the owner should decide explicitly whether
any of the three is required before Day 4-5, or accepted as a known gap to close in a later phase.
