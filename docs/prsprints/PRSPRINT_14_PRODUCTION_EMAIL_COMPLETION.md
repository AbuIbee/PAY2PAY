# PRSprint 14 Completion: Production Email

**Path:** `docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL_COMPLETION.md`
**Spec:** `docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md`

## Status: PASS (with one EXTERNAL BLOCKER, scoped narrowly — see below)

## Architecture

`Business action → persisted notification_event → NotificationService.deliver() (the email consumer)
→ EmailSender (Resend or console) → delivery evidence persisted back onto the same row`. The
notification-event outbox built in PRSprint 13 already *was* the required "notification event → email
delivery consumer → provider" architecture, one layer short of a real provider — `deliver()` is the
consumer; this PRSprint gave it a real provider to call and closed the two places business logic still
reached the `EmailSender` directly (both pre-existing, both structurally justified — see "Unregistered
Invitee Emails" below, not new bypasses this PRSprint introduced).

## Email Provider

**Resend**, called directly via `fetch` (no SDK — this codebase has zero external-provider SDK
dependencies anywhere; `src/lib/payments`/`src/lib/kyc` call their own sandbox HTTP surfaces the same
way). No provider was already selected or referenced anywhere in the repository or environment prior
to this PRSprint (confirmed by search) — Resend was chosen as a well-documented, webhook-capable
transactional provider with a simple REST surface, consistent with "use the provider explicitly
required by the existing PRSprint 14 specification" (the spec does not name one, so this is the
implementation's own reasoned choice, applied exactly once, with no parallel provider path).

**Production configuration status:** all credentials are environment-variable-driven and optional at
the schema level (`RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, `RESEND_WEBHOOK_SECRET`,
`EMAIL_DELIVERY_ENABLED`) — **none of these are configured in this Vercel project today**. Until they
are, `getEmailSender()` falls back to `ConsoleEmailSender` exactly as before this PRSprint, so nothing
regresses; this is the `EXTERNAL BLOCKER` the spec's own Hard Stop rule requires calling out: **live
Resend account creation, domain verification, and API-key/webhook-secret provisioning are outside this
repository and require Product Owner action** (see "Domain Authentication" below for the exact DNS
records that action will need to add).

## Files Changed

**New:**
- `src/lib/notify/emailSender.ts` (interface widened, in place) — `ctaUrl`/`ctaText` in, `providerMessageId` out
- `src/lib/notify/emailDeliveryError.ts` — retryable/category-classified failure type
- `src/lib/notify/emailTemplateShell.ts` (+ `.test.ts`) — shared branded HTML/plain-text wrapper, HTML/header-injection escaping
- `src/lib/notify/resendEmailSender.ts` (+ `.test.ts`) — the real provider
- `src/lib/notify/verifyResendWebhookSignature.ts` (+ `.test.ts`) — Svix-style webhook signature verification
- `src/lib/notify/getEmailSender.ts` — provider-selection + kill-switch factory
- `src/app/api/webhooks/email/resend/route.ts` (+ `.test.ts`) — delivery/bounce/complaint webhook
- `src/lib/admin/emailDeliveryAdminService.ts` (+ `.test.ts`), `getEmailDeliveryAdminService.ts`
- `src/app/api/admin/notifications/email/route.ts` (+ `.test.ts`), `.../retry/route.ts` (+ `.test.ts`)
- `src/components/admin/AdminEmailDelivery.tsx`, `src/app/(app)/admin/notifications/page.tsx`
- `supabase/migrations/20260817090000_prsprint14_email_delivery_evidence.sql`

**Modified:**
- `src/lib/notify/notificationService.ts` — `deliver()` now builds a CTA link, marks email "sent" (not
  "delivered") on provider acceptance, classifies retryable-vs-permanent failures; new
  `redeliverFailedEvent`, `recordProviderDeliveryEvent`, `listRecentEmailEvents`; new required `appUrl`
  dep. `notificationService.test.ts` — 2 pre-existing assertions corrected for the "sent" vs
  "delivered" semantic fix, plus a new "PRSprint 14" describe block.
- `src/lib/notify/consoleEmailSender.ts`, `drizzleNotificationEventRepository.ts`, `getNotificationService.ts`, `testFakes.ts` — interface/schema follow-through.
- `src/lib/auth/getAuthService.ts`, `src/lib/staff/getStaffService.ts`,
  `src/lib/agreementInvitations/getAgreementInvitationService.ts`,
  `src/lib/relationships/getRelationshipInvitationService.ts` — swapped `ConsoleEmailSender` for
  `getEmailSender()`.
- `src/lib/agreementInvitations/agreementInvitationService.ts` — its two pre-existing direct
  unregistered-invitee sends now also pass `ctaUrl`/`ctaText`.
- `src/lib/relationships/relationshipInvitationService.ts` — **real bug fix**: its unregistered-invitee
  email previously embedded the bare raw token (`token=${rawToken}`, no host, no path) instead of a
  working link; now builds `${appUrl}/connections/accept?token=...` matching every other invitation
  email's own established pattern. Gained a new required `appUrl` dep.
- `src/lib/admin/adminCapabilities.ts` — two new capabilities (`review_email_delivery`,
  `retry_email_delivery`), granted to the `support` internal role.
- `src/lib/admin/environmentStatus.ts` — `emailDelivery` is now genuinely conditional
  (`resend` / `console_log_only_no_provider` / `console_log_only_kill_switch`) instead of a fixed
  label, reading the identical inputs `getEmailSender()` decides on.
- `src/db/schema/paymentRetry.ts`, `src/db/schema/enums.ts` — `notification_event` gains `sent_at`/
  `provider_message_id`; `notificationStatusEnum`'s doc comment updated to describe the now-real
  sent/delivered distinction for email.
- `src/components/AppNav.tsx` — new "Email delivery" admin nav link.
- Six test-fake/test files updated for the above interface changes (auth, notify, relationships,
  admin, environmentStatus, env).

## Database Changes

One migration, additive only: `notification_event.sent_at` (nullable timestamptz),
`notification_event.provider_message_id` (nullable text). No enum change — `notification_status`
already had `sent` as a value (added in Sprint 17, never previously reached for email). No RLS change
(no new table; existing deny-all-for-anon/authenticated RLS on `notification_event` already covers the
new columns). Applied to the linked production project; verified `local == remote` and
`db push --dry-run` reports "Remote database is up to date" (see Supabase Verification below).

## Email Event Mapping

No new mapping structure was built — `DEFAULT_CHANNELS` (`src/lib/notify/eventTypes.ts`) already *is*
the canonical event-type → channel-eligibility mapping (PRSprint 13), and `NOTIFICATION_TEMPLATES`
(`templates.ts`) already produces one `emailBody` per type. Every one of the types requirement #8 names
as "likely appropriate for email" already had `"email"` in its `DEFAULT_CHANNELS` entry before this
PRSprint (`agreement_invitation`, `agreement_action_required`, `agreement_decided`,
`agreement_counterparty_signed`, `agreement_signed`, `amendment`, `amendment_decided`, plus every
payment/security/relationship type) — reviewed and confirmed correct, not rebuilt.

## Templates

No new templates were written. The ~30 existing `NOTIFICATION_TEMPLATES` entries (PRSprint 10/11/13)
keep producing plain text; `renderBrandedEmail` (new) is the one shared place that turns that plain
text into a branded, responsive HTML email plus a plain-text fallback — applied uniformly by
`ResendEmailSender`, so no template needed to change to get consistent branding.

## Recipient Resolution

**Registered users:** unchanged — `NotificationService.deliver()` resolves the recipient's email via
`UserContactReader.getEmail(record.recipientUserId)`, a server-side DB lookup keyed by the row's own
column; no route anywhere accepts a client-supplied `recipientEmail` override.

**Unregistered invitees:** `AgreementInvitationService`/`RelationshipInvitationService` still send
directly through `EmailSender.send()` for this one case (a not-yet-registered invitee has no
`recipientUserId` for `notify()`'s NOT NULL FK contract to represent) — this predates PRSprint 13,
was reviewed and left in place there, and is unchanged in shape by this PRSprint: it now gets real
delivery (same `getEmailSender()`) and a working link (the `RelationshipInvitationService` bug above),
but still does not produce a `notification_event` row, so it has no delivery-attempt evidence or
retry/idempotency beyond "the invitation itself is only created once per request." Documented here,
not concealed — see Remaining Issues.

## Secure Link Architecture

Every email CTA/link is built server-side from `APP_URL` (never a client-supplied host) plus either an
agreement id (`/agreements/detail?id=...`, the same id/route the authenticated web UI itself already
uses) or an opaque invitation token (`/i/{token}`, `/connections/accept?token=...`,
`/staff/accept-invitation?token=...` — all pre-existing secure invitation mechanisms, none duplicated).
No raw database id beyond what the authenticated UI already exposes for that same resource, no
auth/session/password-reset token ever appears in an unrelated email.

## Idempotency

Two independent layers, both already correct by construction: (1) `notify()`'s own
`dedupeKey`+channel uniqueness (PRSprint 13, unchanged) prevents a duplicate *event row*; (2)
`findDueForRetry` only ever selects rows still in status `failed`, so a row that has already
transitioned to `sent`/`delivered` can never be picked up and re-sent by the retry/cron path — verified
directly (existing test, unchanged). New for this PRSprint: `redeliverFailedEvent` (admin retry)
explicitly rejects any id not currently `status === "failed"`, so a second retry click (or a retry on
an event that succeeded in the interim) is rejected rather than double-sent — verified by a dedicated
test.

## Retry Architecture

`EmailDeliveryError.retryable` (new) lets `ResendEmailSender` tell `NotificationService.deliver()`'s
catch block whether a failure is worth the existing bounded-retry/backoff budget (429/5xx/network →
retryable) or should dead-letter on the very first attempt (401/403/4xx → not retryable — an invalid
recipient or misconfigured request will fail identically on every retry). Bounded retry itself
(`maxAttempts`, `retryDelayMs`) is unchanged from PRSprint 13/Sprint 17.

## Delivery Evidence

`notification_event.provider_message_id` + `sent_at` (new) record what the provider accepted and when;
`delivered_at` is now reserved for an actual confirmed-delivery webhook. `attempt_count`/
`failure_reason`/`next_retry_at` (unchanged, PRSprint 13) still capture attempt history. No separate
delivery-attempts table — one row per (event, channel) already carries everything needed, and a
provider webhook only ever updates that same row (never creates a new one).

## Provider Security

`RESEND_API_KEY` is read once in `getEmailSender()` and passed into `ResendEmailSender`'s constructor
(mirrors `SandboxPaymentProvider`'s identical precedent) — the sender class never touches
`process.env` itself. Never logged, never returned from any API response, never written into a
`notification_event.payload`. `ResendEmailSender` only ever logs a masked recipient (`u***@domain`)
and an HTTP status on failure — never the raw provider response body, which could echo request
content. Verified directly: `resendEmailSender.test.ts` asserts the API key never appears in the
outbound request body; grepped every new/changed file for `RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET` —
each appears only in `env.ts`, `getEmailSender.ts` (constructs `ResendEmailSender`), and the webhook
route (reads the secret to verify a signature) — never in a response, log line, or payload.

## Domain Authentication

**Not yet configured — Product Owner action required, EXTERNAL BLOCKER.** Once a Resend account and
sending domain are provisioned, Resend requires (typical for their domain-verification flow, to be
confirmed against Resend's own dashboard at setup time): an **SPF** TXT record (`v=spf1 include:...`)
merged into the domain's existing SPF record if one already exists (a domain can only have one), a
**DKIM** CNAME/TXT record pair Resend generates per-domain, and a recommended (Resend does not require
it to send, but strongly recommends it) **DMARC** TXT record at `_dmarc.<domain>`. This repository
cannot add DNS records itself — recorded here, not silently skipped, exactly per the spec's own "do
not falsely mark production email as fully ready" instruction.

## Test Results

- New tests: `resendEmailSender.test.ts` (8), `verifyResendWebhookSignature.test.ts` (7),
  `emailTemplateShell.test.ts` (8), `notificationService.test.ts` (+13 PRSprint 14 tests, 2 existing
  corrected), `emailDeliveryAdminService.test.ts` (9), admin route tests (9), webhook route test (7),
  `env.test.ts` (+3), `environmentStatus.test.ts` (+3 new, 1 rewritten).
- Full suite: **1034/1035 passed** (1 pre-existing, unrelated flake —
  `AddFinancialAccountForm.test.tsx`'s submit-button-disable test, a React-component timing test that
  passes in isolation on every run and is untouched by this PRSprint; not a regression, not concealed).
- Typecheck: clean. Lint (every changed/new file): clean, 0 errors/warnings.
- Production build (`next build`): succeeded; `/api/webhooks/email/resend`,
  `/api/admin/notifications/email`, `/api/admin/notifications/email/retry`, `/admin/notifications` all
  present in the route manifest.

## Security Tests

- **Arbitrary recipient substitution**: structurally impossible — no route accepts a
  `recipientEmail`/`to` override; every send resolves the destination server-side.
- **Fabricated event**: no route accepts a client-supplied `notificationType`/event id for dispatch;
  the webhook route only ever *transitions* an existing row it looked up by a provider-generated
  `provider_message_id`, never creates a business event.
- **Unauthorized email processing (admin routes)**: verified directly —
  `emailDeliveryAdminService.test.ts` + both admin route tests: anonymous → 401; ordinary member → 403;
  `platform_admin` with no internal role → 403; `platform_admin` with `support` role → allowed;
  `platform_owner` → allowed (bypass, matching every other admin-capability precedent).
  `redeliverFailedEvent` additionally rejects retrying a non-`failed` event (409-equivalent
  `ValidationError`).
- **Cross-tenant/unauthorized webhook processing**: `POST /api/webhooks/email/resend` with a missing or
  invalid `svix-*` signature → 403 (verified). A verified event referencing an unknown
  `provider_message_id` → 200/no-op, not an error and not a write to an arbitrary row (verified).
- **HTML/header injection**: `emailTemplateShell.test.ts` — a malicious display name containing
  `<img onerror=...>` is escaped, not rendered as live HTML; CR/LF in a subject/preheader is stripped
  before use; a non-`http(s)` `ctaUrl` (e.g. `javascript:...`) is never rendered as a link.
- **Secret exposure**: see Provider Security above — verified directly in `resendEmailSender.test.ts`.

## Authentication Regression

Full pre-existing auth suite unaffected: `authService.test.ts` (33 tests, including the IDOR
`revokeSession` case), `crossAccountIsolation.test.ts`, `password.test.ts`, `mfaService.test.ts`,
`session.test.ts`, `totp.test.ts` — all still passing. `AuthService`'s only change is which
`EmailSender` implementation it's constructed with (`getEmailSender()` instead of a hardcoded
`ConsoleEmailSender`); its verification/password-reset token lifecycle, link generation, and session
logic are byte-for-byte unchanged.

## Admin Regression

`adminService.test.ts` (30 tests), `adminRoleService.test.ts`, `retentionHoldService.test.ts`,
`adminRestrictionService.test.ts`, `supportCaseService.test.ts`, `appealService.test.ts`,
`adminCaseReviewService.test.ts` — all still passing, unmodified in behavior. The two new capabilities
were added to the existing closed vocabulary (`ADMIN_CAPABILITIES`) without touching any existing
entry; `support`'s existing three capabilities are untouched, just extended with two more.

## PRSprint 13 Regression

Notification event taxonomy unchanged (no type added, removed, or reclassified). Recipient resolution
unchanged for every registered-user path. Idempotency unchanged/still verified. No provider logic was
moved into `AgreementService`/`AmendmentService`/`SignatureService` — they still only ever call
`NotificationService.notify()`, exactly as PRSprint 13 left them.

## PRSprint 12/12A Regression

- Signatures/amendments/PDFs: `signatureService.test.ts`, `amendmentService.test.ts`,
  `agreementService.test.ts` all still passing, untouched by this PRSprint's scope.
- Rate limiting: `rate-limit.test.ts` (15 tests) still passing.
- Schema drift: `supabase db push --linked --dry-run` → "Remote database is up to date." after applying
  this PRSprint's own migration.
- Migration alignment: `supabase migration list --linked` — every migration, including the new one,
  shows `local == remote`.
- Production environment: `GET https://paid2you.com/api/health` → `"environment":"production"`
  (checked post-merge, see Production Verification).

## CI Results

Lint/typecheck/full test suite (1034/1035, 1 pre-existing unrelated flake) all green locally; GitHub
Actions CI run reported separately in the tracker/PR.

## Supabase Verification

- Correct linked project: `lmpicrmmixpvkwwhcxbh` ("Paid2You", ACTIVE_HEALTHY) — confirmed against the
  other unrelated projects on the account.
- `supabase migration list --linked`: all 29 migrations `local == remote`, including
  `20260817090000_prsprint14_email_delivery_evidence`.
- `supabase db push --linked --dry-run`: "Remote database is up to date."
- New columns are additive/nullable — no backfill required, no existing row touched.

## Vercel Verification

See Production Verification in the chat completion report (post-merge): `/api/health` reports
production; the new admin/webhook routes deploy cleanly (confirmed via local `next build`'s route
manifest — a Vercel-specific build failure is a distinct risk category from a local build succeeding,
noted honestly rather than assumed away).

## Production Email Verification

**Not performed — cannot be, until the EXTERNAL BLOCKER (Resend account/domain/API key) is resolved by
the Product Owner.** `getEmailSender()` currently returns `ConsoleEmailSender` in production exactly as
it did before this PRSprint, so no live email has been sent and none can be until credentials exist.
This is the one Acceptance Criterion this PRSprint cannot self-certify end-to-end — the code path is
fully built, tested with a mocked provider, and ready; the live send is blocked on infrastructure this
repository has no access to provision.

## Remaining Issues (not concealed)

1. **EXTERNAL BLOCKER**: no live Resend account/domain/API key/webhook secret exists yet — real email
   delivery is code-complete but not yet live. Product Owner action required (see Domain Authentication
   above for the exact DNS records to expect).
2. Unregistered-invitee emails (`AgreementInvitationService`/`RelationshipInvitationService`'s two
   direct-send call sites) still bypass the `notification_event` outbox entirely — they get real
   delivery now, but no persisted delivery-attempt evidence, no admin visibility, no retry. This is a
   pre-existing architectural constraint (no `recipientUserId` to hang a row off), not something this
   PRSprint introduced or was asked to redesign; flagged as a candidate for a future PRSprint if
   delivery evidence for that specific path becomes a requirement (e.g. by making
   `notification_event.recipient_user_id` nullable and adding a `recipient_email` column).
3. `sms` still conflates "sent" and "delivered" (goes straight to `delivered` via `ConsoleSmsSender`) —
   unchanged, explicitly PRSprint 15's scope, not touched here.
4. No dedicated unit test for `getEmailSender.ts` itself (its decision logic is a two-line ternary,
   exercised identically and indirectly by `environmentStatus.test.ts`'s `computeEmailDeliveryStatus`
   tests) — a deliberate, low-risk scope decision given `getServerEnv()`'s process-wide memoization
   makes directly unit-testing the factory function awkward without disturbing other test files in the
   same worker process.
5. One pre-existing, unrelated flaky test (`AddFinancialAccountForm.test.tsx`) observed during the full
   suite run — passes in isolation, not caused by this PRSprint, not fixed here (out of scope).
