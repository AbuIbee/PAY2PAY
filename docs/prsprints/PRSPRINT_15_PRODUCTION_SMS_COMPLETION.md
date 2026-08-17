# PRSprint 15 Completion: Production SMS

**Path:** `docs/prsprints/PRSPRINT_15_PRODUCTION_SMS_COMPLETION.md`
**Spec:** `docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md`

## Status: PASS (with one EXTERNAL BLOCKER, scoped narrowly — see below)

## Architecture

`Business action → persisted notification_event → NotificationService.deliver() (the SMS consumer,
shared with email) → SmsSender (Twilio or console) → delivery evidence persisted back onto the same
row`. Identical shape to PRSprint 14's email architecture, deliberately — `deliver()`'s SMS branch is
the one and only consumer of `SmsSender`; no business-domain service (`AgreementService`,
`AmendmentService`, `SignatureService`, auth handlers) calls a provider directly. Two pre-existing
direct-send call sites (unregistered-invitee SMS in `AgreementInvitationService`, MFA OTP delivery in
`MfaService`) keep their existing shape but now resolve to the real provider via the same
`getSmsSender()` factory — same reviewed pattern as PRSprint 14's email equivalents.

## SMS Provider

**Twilio**, called directly via `fetch` (no SDK — matches this codebase's zero-dependency provider
style, identical to `ResendEmailSender`). No provider was previously referenced anywhere in the
repository or environment (confirmed by search). **Sender type**: configurable as either a Messaging
Service (Twilio's own recommended production pattern — supports A2P 10DLC sender-pool rotation
transparently) or a single From number; Messaging Service takes priority when both are configured.

**Production configuration status**: all credentials are environment-variable-driven and optional at
the schema level (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`,
`TWILIO_FROM_NUMBER`, `SMS_DELIVERY_ENABLED`) — **none configured in this Vercel project yet**. Until
they are, `getSmsSender()` falls back to `ConsoleSmsSender` exactly as before this PRSprint (including
for MFA SMS enrollment/step-up and the unregistered-invitee invitation path), so nothing regresses.

**Carrier/registration status**: unknown/not started — **EXTERNAL BLOCKER**. A2P 10DLC brand/campaign
registration (or toll-free verification, if a toll-free number is chosen instead) is required by US
carriers before Twilio will reliably deliver application-to-person traffic at volume; this is Twilio
account-level provisioning outside this repository, requiring Product Owner action. Code is
complete and tested against a mocked provider; live sending is blocked on this exactly as PRSprint 14's
own email delivery was blocked on Resend domain verification before that was resolved.

## Files Changed

**New:**
- `src/lib/phone.ts` (+ `.test.ts`) — E.164 normalization/validation/masking
- `src/lib/notify/smsDeliveryError.ts` — retryable/category-classified SMS failure type
- `src/lib/notify/twilioSmsSender.ts` (+ `.test.ts`) — the real provider
- `src/lib/notify/verifyTwilioWebhookSignature.ts` (+ `.test.ts`) — Twilio's HMAC-SHA1 webhook signature algorithm
- `src/lib/notify/getSmsSender.ts` — provider-selection + kill-switch factory
- `src/lib/notify/drizzleSmsOptOutRepository.ts` — STOP-suppression persistence
- `src/db/schema/smsOptOut.ts` — new `sms_opt_out` table
- `src/app/api/webhooks/sms/twilio/inbound/route.ts` (+ `.test.ts`) — STOP/HELP inbound handler
- `src/app/api/webhooks/sms/twilio/status/route.ts` (+ `.test.ts`) — delivery status callback
- `src/lib/admin/smsDeliveryAdminService.ts` (+ `.test.ts`), `getSmsDeliveryAdminService.ts`
- `src/app/api/admin/notifications/sms/route.ts` (+ `.test.ts`), `.../retry/route.ts` (+ `.test.ts`)
- `src/components/admin/AdminSmsDelivery.tsx`
- `supabase/migrations/20260818090000_prsprint15_sms_opt_out.sql`

**Modified:**
- `src/lib/notify/notificationService.ts` — `deliver()`'s SMS branch now checks opt-out suppression
  before sending, appends the CTA link (same `buildCtaUrl` used for email) to the message body, marks
  "sent" (not "delivered") on provider acceptance, classifies retryable-vs-permanent SMS failures.
  `recordProviderDeliveryEvent` generalized from an email-specific
  `"delivered"|"bounced"|"complained"` union to a channel-agnostic `"delivered"|"failed"` +
  caller-supplied `failureReason`, so the one method correctly serves both webhooks.
  `listRecentEmailEvents` renamed to the already-channel-agnostic `listRecentByChannel` (the
  underlying repository method was already generic). New `recordSmsOptOut`. New required `smsOptOuts`
  dependency.
- `src/lib/notify/smsSender.ts`, `consoleSmsSender.ts`, `getNotificationService.ts`, `testFakes.ts` — interface/wiring follow-through.
- `src/lib/notify/drizzleUserContactReader.ts` — **real correctness fix**: `getPhone()` previously read
  `user_account.phone`, a column confirmed (full-repo search) never written anywhere in this
  codebase — the SMS channel has never had a real destination to resolve for any user. Now resolves
  from a verified SMS MFA credential (`mfa_credential` where `method='sms'` and `verifiedAt` is set) —
  see requirement #9/Consent below.
- `src/lib/auth/getMfaService.ts`, `src/lib/agreementInvitations/getAgreementInvitationService.ts` — swapped `ConsoleSmsSender` for `getSmsSender()`.
- `src/lib/agreementInvitations/agreementInvitationService.ts` — `recipientPhone` now normalized to
  E.164 and rejected if unparseable, instead of stored verbatim.
- `src/lib/notify/eventTypes.ts` — `sms` added to `DEFAULT_CHANNELS` for exactly the non-critical types
  that are genuinely time-sensitive/action-required (see Event Mapping below); every critical type
  already included `sms` since Sprint 17.
- `src/app/api/webhooks/email/resend/route.ts` — updated for `recordProviderDeliveryEvent`'s
  generalized signature (maps Resend's bounced/complained into the shared outcome/failureReason
  shape); no behavioral change.
- `src/lib/admin/adminCapabilities.ts` — two new capabilities (`review_sms_delivery`,
  `retry_sms_delivery`), granted to `support`, kept separate from the email capabilities per
  channel-separation (requirement #32).
- `src/lib/admin/environmentStatus.ts` — `smsDelivery` is now genuinely conditional
  (`twilio` / `console_log_only_no_provider` / `console_log_only_kill_switch`), mirroring
  `emailDelivery`'s identical PRSprint 14 treatment.
- `src/app/(app)/admin/notifications/page.tsx`, `src/components/AppNav.tsx` — the existing email
  delivery admin page now also shows an SMS section; page/nav title generalized to "Notification
  delivery."
- Six test-fake/test files updated for the above interface changes (auth MFA fakes, admin ops fakes,
  environmentStatus tests, env tests).

## Database Changes

One migration, additive only: `CREATE TABLE sms_opt_out (phone text PRIMARY KEY, opted_out_at, source,
created_at)`, RLS enabled with zero policies (deny-all for anon/authenticated, matching every other
table in this schema). No change to `notification_event` — its `sent_at`/`provider_message_id` columns
(PRSprint 14) were already channel-generic by design, reused directly for SMS with zero schema change,
directly satisfying requirement #31 ("extend cleanly instead of duplicating"). Applied to the linked
production project; verified `local == remote` and `db push --dry-run` reports up to date.

## SMS Event Mapping

No new mapping structure — `DEFAULT_CHANNELS` (`eventTypes.ts`) already *is* the canonical
type-to-channel mapping (PRSprint 13/Sprint 17); every critical type already included `sms`. This
PRSprint added `sms` to exactly five non-critical types, chosen for being genuinely time-sensitive/
action-required (matching requirement #13's own framing), not blanket-added to every type:
`agreement_invitation`, `agreement_action_required`, `agreement_counterparty_signed`, `amendment`,
`relationship_invitation`. Left unchanged (email+in_app only): purely-informational "here's what
happened" types (`agreement_decided`, `amendment_decided`, `agreement_invitation_response`,
`relationship_accepted/declined/activated`) and `agreement_signed` itself (confirmatory, not
action-required).

## Templates

No new templates — `NOTIFICATION_TEMPLATES` already produces an `smsBody` for every type (Sprint 17,
already reviewed for conciseness). `deliver()` appends the same CTA link email uses (built from
`APP_URL` + `relatedAgreementId`) directly to the SMS body text when present — no separate template
change needed, mirroring PRSprint 14's "delivery-boundary, not per-template" design.

## Recipient Resolution

**Registered users**: `NotificationService.deliver()` resolves the destination via
`UserContactReader.getPhone(recipientUserId)` — server-side, keyed by the row's own column, never a
client-supplied value.

**Unregistered invitees**: `AgreementInvitationService`'s existing direct-send path (pre-dates
PRSprint 13, reviewed and left in place there and in PRSprint 14) — the inviter supplies the phone
number, now normalized to E.164 and validated before storage/use.

## Consent / Eligibility

**The real, honestly-documented gap**: this codebase has no dedicated "I consent to receive
transactional SMS from Paid2You" flow. `user_account.phone` — the column that would naturally hold
such a self-declared number — is never written anywhere. The best available proxy for "this user
controls this number and took a deliberate action involving it" is a **verified SMS MFA credential**:
enrollment requires successfully entering an OTP code sent to that exact number
(`MfaService.beginSmsEnrollment`/`confirmSmsEnrollment`), which is why `getPhone()` now resolves from
there. This is meaningfully stronger than an unverified free-text field, but it is not a dedicated
SMS-notification-consent flow, and is being used as the best-available proxy, not represented as
solving the general consent question — that remains open, and a natural candidate for PRSprint 16's
own explicit preferences/consent scope, not invented here.

## Phone Normalization

`src/lib/phone.ts` — canonical E.164 (`+<countrycode><digits>`). Handles already-E.164 input (with
formatting punctuation stripped) and bare 10/11-digit US numbers (assumes `+1`, this codebase's
explicit "Paid2You will send transactional SMS in the United States" scope); anything else is rejected
rather than guessed at. Not a full libphonenumber port — deliberately, matching this codebase's
zero-dependency style for cross-cutting concerns; documented as a real, narrow limitation (a non-US,
non-already-E.164 number will be rejected rather than normalized).

## Secure Links

Identical mechanism to PRSprint 14: every SMS CTA link is built server-side from `APP_URL` (the
already-hardened, PRSprint 14A-fixed centralized variable — never a client-controlled Host header) plus
a known route path. No new link-generation code path was introduced; SMS reuses
`NotificationService`'s existing `buildCtaUrl`.

## Idempotency

Two layers, both already correct by construction (PRSprint 13/14, unchanged): `notify()`'s
`dedupeKey`+channel uniqueness prevents duplicate event rows; `findDueForRetry` only ever selects rows
still `status = "failed"`, so a row that already transitioned to `sent`/`delivered` can never be
re-sent by the retry/cron path. New for SMS specifically: the opt-out check happens *before* any send
attempt, so a suppressed number can never accumulate duplicate attempts; `redeliverFailedEvent` (admin
retry) rejects any id not currently `status === "failed"`.

## Retry Architecture

`SmsDeliveryError.retryable` (mirrors `EmailDeliveryError` exactly): 429/5xx/network → retryable,
bounded backoff; 401/403/misconfiguration/invalid-number/opted-out → non-retryable, dead-lettered on
the first attempt. Twilio error code 21610 (recipient previously unsubscribed) is explicitly classified
`opted_out`/non-retryable as a second layer behind the pre-send suppression check.

## Delivery Evidence

Reuses `notification_event.sent_at`/`provider_message_id` (PRSprint 14, zero new columns).
`TwilioSmsSender` sets `StatusCallback` on every send to `${APP_URL}/api/webhooks/sms/twilio/status`,
so delivery-status callbacks route correctly without requiring separate manual configuration in the
Twilio console for every messaging service/number.

## Provider Security

`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` read once in `getSmsSender()`, injected into
`TwilioSmsSender`'s constructor (mirrors `ResendEmailSender`'s identical precedent) — the sender class
never touches `process.env`. Never logged, never returned from any response, never written into a
`notification_event.payload`. Only a masked phone (`+1********67`) and Twilio's own numeric error code
are ever logged on failure — never the raw response body, never the full destination.

## Webhook / Callback Security

Both webhooks (`inbound`, `status`) use Twilio's own HMAC-SHA1 signature algorithm
(`verifyTwilioWebhookSignature.ts`): the exact webhook URL (reconstructed from the trusted `APP_URL`,
never `request.url` or a Host header) plus every POST parameter concatenated in sorted-key order,
HMAC-SHA1'd with `TWILIO_AUTH_TOKEN`, compared against `X-Twilio-Signature`. An invalid/missing
signature → 403, verified by tests for both routes. Idempotent: the `status` webhook re-applies the
same status transition on redelivery; the `inbound` webhook's opt-out record is an upsert. Neither
webhook ever creates a new business event or notification_event row — `status` only transitions an
existing row looked up by provider-generated `MessageSid`; `inbound` only ever calls
`recordSmsOptOut`.

## Opt-Out / Compliance

`POST /api/webhooks/sms/twilio/inbound` recognizes STOP-family keywords (stop, stopall, unsubscribe,
cancel, end, quit — case-insensitive) and records the number in `sms_opt_out`; HELP is acknowledged but
not acted on further (Twilio's own carrier-level Advanced Opt-Out already handles the standard
STOP/HELP auto-reply text on a properly configured number — this route is deliberately not a general
conversational surface, per requirement #23's own instruction). `NotificationService.deliver()` checks
`sms_opt_out` before every send attempt — an opted-out number is never even attempted, marked
`failed`/`recipient_opted_out`, not retried. Email is entirely independent — an SMS opt-out never
touches `notification_preference` or any email-channel row.

## Test Results

- New tests: `phone.test.ts` (15), `twilioSmsSender.test.ts` (9), `verifyTwilioWebhookSignature.test.ts`
  (9), `notificationService.test.ts` (+20 PRSprint 15 tests, 1 existing corrected for SMS's "sent" vs
  "delivered" semantics), `smsDeliveryAdminService.test.ts` (8), both SMS admin route tests (9 total),
  both SMS webhook route tests (11 total), `environmentStatus.test.ts` (+4 new).
- Full suite: **1114/1114 passed** (152/152 files — zero flakes this run).
- Typecheck: clean. Lint (every changed/new file): clean, 0 errors/warnings.
- Production build: succeeded; `/api/webhooks/sms/twilio/inbound`, `/api/webhooks/sms/twilio/status`,
  `/api/admin/notifications/sms(/retry)`, `/admin/notifications` (now showing both channels) all
  present in the route manifest.

## Invitation SMS Test

`AgreementInvitationService.createInvitation` with a `recipientPhone` and no matching existing
account: normalizes to E.164, rejects malformed input, sends via `EmailSender`+`SmsSender` (the
unregistered-invitee direct-send path) with the secure `${APP_URL}/i/{token}` link embedded — verified
by the existing (unmodified-in-assertions) `agreementInvitationService.test.ts` suite plus manual
tracing of the exact code path. For an *existing recognized user*, `agreement_invitation` now includes
`sms` in `DEFAULT_CHANNELS` — verified directly by a dedicated `notificationService.test.ts` test
(CTA-link-in-body assertion) using the same event type.

## Agreement SMS Test

`agreement_action_required` — added to `DEFAULT_CHANNELS`'s sms set; verified directly: correct
recipient (server-resolved via `getPhone`), correct minimal content (existing Sprint 17 template,
unchanged), correct production URL appended, no sensitive amount/schedule data in the message body
(templates.ts's own established "non-sensitive only" precedent, unchanged).

## Signature SMS Test

`agreement_counterparty_signed` — added to `DEFAULT_CHANNELS`'s sms set (used for both the main
agreement and amendment signing, unchanged from PRSprint 13's design). No PDF is ever attached via
MMS — this codebase sends SMS only (`Body`, no `MediaUrl`) — the executed PDF remains behind the
existing authenticated `/agreements/pdf` route, unchanged.

## Amendment SMS Test

`amendment` (proposal) — added to `DEFAULT_CHANNELS`'s sms set; `amendment_decided` (the completion/
decision events) deliberately left email+in_app only (informational, not action-required — see Event
Mapping's own rationale). Version correctness is unchanged from PRSprint 11/13 (payload always carries
the agreement's own current state at notify-time; no separate SMS-specific version logic was
introduced).

## Duplicate Processing Test

Verified directly: `redeliverFailedEvent` rejects a retry on a non-`failed` event; the STOP-webhook's
opt-out upsert is idempotent (dedicated test: two identical STOP replies produce one opt-out record,
no error); the status-webhook's status transition is idempotent by construction (setting the same
status twice is a no-op-equivalent update). No uncontrolled duplicate SMS possible through any tested
path.

## Provider Failure Tests

All verified directly in `twilioSmsSender.test.ts`: timeout/network failure → retryable/timeout; 429 →
retryable/rate_limited; 500 → retryable/provider_error; 401/403 → non-retryable/configuration; Twilio
error 21610 → non-retryable/opted_out; other 4xx → non-retryable/invalid_number. Webhook replay/forged
webhook covered in both route test suites (see Security Tests below).

## Security Tests

- **Arbitrary destination substitution**: structurally impossible — no route accepts a client-supplied
  SMS destination; every send resolves the phone server-side from `recipientUserId` (registered) or
  the inviter-supplied, server-normalized `recipientPhone` (unregistered-invitee path only, an
  inherently pre-account context).
- **Fabricated event**: no route accepts a client-supplied notification type/event for dispatch; both
  webhooks only ever transition an existing row (looked up by provider-generated id) or record an
  opt-out — never create a business event.
- **Unauthorized SMS admin access**: verified directly — anonymous → 401; ordinary member → 403;
  `platform_admin` with no internal role → 403; `support` role → allowed; `platform_owner` → allowed.
- **Cross-tenant attempt**: the same recipient-resolution/authorization boundary that already prevents
  this for email prevents it for SMS — no code path lets one user's action target another user's
  phone/notification row.
- **Forged webhook**: both `inbound` and `status` routes reject a missing or invalid
  `X-Twilio-Signature` with 403 — verified directly by tests for both.
- **Secret exposure**: verified directly in `twilioSmsSender.test.ts` — the auth token never appears
  in the outbound request body; grepped every new/changed file for `TWILIO_AUTH_TOKEN` — appears only
  in `env.ts`, `getSmsSender.ts` (constructs `TwilioSmsSender`), and both webhook routes (read to
  verify a signature) — never in a response, log line, or payload.

## Authentication Regression

Full pre-existing auth suite unaffected: `authService.test.ts`, `mfaService.test.ts`,
`crossAccountIsolation.test.ts`, `session.test.ts` — all still passing. `MfaService`'s only change is
which `SmsSender` implementation it's constructed with; its OTP generation, hashing, challenge
expiration, and step-up logic are byte-for-byte unchanged.

## Admin Regression

`adminService.test.ts`, `adminRoleService.test.ts`, `retentionHoldService.test.ts`,
`adminRestrictionService.test.ts`, `supportCaseService.test.ts`, `appealService.test.ts` — all still
passing, unmodified in behavior. The two new SMS capabilities were added to the existing closed
vocabulary without touching any existing entry.

## PRSprint 14 Regression

`resendEmailSender.test.ts`, `verifyResendWebhookSignature.test.ts`, `emailTemplateShell.test.ts`,
`emailDeliveryAdminService.test.ts` — all still passing. The one PRSprint-14-authored file this
PRSprint modified (`resend/route.ts`) only adapted to `recordProviderDeliveryEvent`'s generalized
signature — behavior (which Resend events map to which outcome) is unchanged, verified by the
unmodified assertions in that route's own test file continuing to pass. Live-verified post-merge (see
Production Verification): Resend integration, `/api/health` production status, and email links
unaffected.

## PRSprint 13 Regression

Notification event taxonomy: 5 types gained `sms` in `DEFAULT_CHANNELS` (documented above), zero types
added/removed/reclassified as critical, zero types renamed. Recipient resolution unchanged for
email/in_app. Idempotency unchanged/still verified. No provider logic was moved into
`AgreementService`/`AmendmentService`/`SignatureService` — they still only ever call
`NotificationService.notify()`.

## PRSprint 12/12A Regression

- Signatures/amendments/PDFs: unmodified, all relevant suites still passing.
- Rate limiting: `rate-limit.test.ts` still passing; SMS invitation abuse is already covered by
  `POST /api/agreement-invitations`'s existing per-inviter/per-target (email-or-phone) rate limiting
  (PRSprint 05, confirmed unchanged and still including `recipientPhone` in its target key).
  request.
- Schema drift: `supabase db push --linked --dry-run` → "Remote database is up to date" after applying
  this PRSprint's own migration.
- Migration alignment: `supabase migration list --linked` — every migration, including the new one,
  `local == remote`.
- Production environment: verified post-merge (see Production Verification).

## CI Results

Lint/typecheck/full test suite (1114/1114) all green locally; GitHub Actions CI run reported separately
in the tracker/PR.

## Supabase Verification

- Correct linked project: `lmpicrmmixpvkwwhcxbh` ("Paid2You", ACTIVE_HEALTHY).
- `supabase migration list --linked`: all 30 migrations `local == remote`, including
  `20260818090000_prsprint15_sms_opt_out`.
- `supabase db push --linked --dry-run`: "Remote database is up to date."

## Vercel Verification

See Production Verification in the chat completion report (post-merge).

## Production SMS Verification

**Not performed — cannot be, until the EXTERNAL BLOCKER (Twilio account/A2P registration/credentials)
is resolved by the Product Owner.** No phone number was invented or guessed at, per the spec's own
explicit instruction. `getSmsSender()` currently returns `ConsoleSmsSender` in production exactly as it
did before this PRSprint, so no live SMS has been sent and none can be until credentials exist. The
code path is fully built and tested against a mocked provider; the live send is blocked on
infrastructure this repository has no access to provision.

## External Provider Blockers

1. No live Twilio account exists yet.
2. A2P 10DLC brand/campaign registration (or toll-free verification) status: unknown/not started —
   required before US carriers will reliably deliver application-to-person SMS at volume.
3. No sender number/messaging service provisioned.

All three require Product Owner action outside this repository — code is complete and ready the moment
credentials exist, mirroring PRSprint 14's identical EXTERNAL BLOCKER pattern (later resolved in
PRSprint 14A's follow-up provisioning).

## Remaining Issues (not concealed)

1. **EXTERNAL BLOCKER**: see above — real SMS delivery is code-complete but not yet live.
2. **Consent gap, honestly documented, not silently assumed solved**: no dedicated SMS-notification
   consent flow exists; the verified-MFA-phone proxy is the best available evidence today, not a
   purpose-built consent record. A natural candidate for PRSprint 16.
3. Unregistered-invitee SMS (`AgreementInvitationService`'s direct-send path) still bypasses the
   `notification_event` outbox entirely — same pre-existing architectural constraint already documented
   for email in PRSprint 14 (no `recipientUserId` to hang a row off).
4. `src/lib/phone.ts` only normalizes already-E.164 values and US-shaped numbers — a non-US number
   supplied in a non-E.164 format will be rejected rather than normalized (documented limitation, not a
   silent failure — the caller gets a clear validation error).
5. No dedicated unit test for `getSmsSender.ts` itself, for the same reason `getEmailSender.ts` has
   none (its decision logic is exercised identically and indirectly via
   `environmentStatus.test.ts`'s `computeSmsDeliveryStatus` tests; `getServerEnv()`'s process-wide
   memoization makes directly unit-testing the factory awkward without disturbing other test files in
   the same worker process).
