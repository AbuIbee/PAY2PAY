# PRSprint 16 Completion: Notification Preferences & Delivery History

**Path:** `docs/prsprints/PRSPRINT_16_NOTIFICATION_PREFERENCES_DELIVERY_HISTORY_COMPLETION.md`
**Spec:** `docs/prsprints/PRSPRINT_16_NOTIFICATION_PREFERENCES_DELIVERY_HISTORY.md`

## Status: PASS

No external blocker of its own — PRSprint 16's implementation and every production-verifiable portion
of it pass independently of PRSprint 15's still-pending Twilio activation (carried forward unchanged,
see its own section below).

## Interruption Note

This PRSprint's execution was interrupted mid-session by an API response-stream failure. Before
continuing, the exact repository state was verified: `git status` against the five files already
touched, full-content reads of each (no truncation, syntactically complete), a clean `tsc --noEmit`,
and a passing run of the directly-affected test files. **No repository corruption occurred — the
interruption was a response-stream failure only.** All pre-interruption work was fully persisted and
valid; nothing was reverted or redone.

## Architecture

This PRSprint found substantial pre-existing infrastructure (Sprint 17/18B): a full `notification_preference`
table + `NotificationService.getPreferences`/`setPreference`, a `NotificationPreferences` settings
component, a `NotificationCenter` history component, and three API routes
(`GET/POST /api/notifications/preferences`, `GET /api/notifications`, `POST /api/notifications/read`) —
all already scoped correctly to the authenticated user server-side, already correctly refusing to let a
critical type be disabled. The real, substantive gaps were the ones only PRSprint 15's own existence
could have created: **no SMS eligibility/consent model, no provider-suppression integration, and a
history view that showed one card per delivery-channel row instead of one per logical notification.**
This PRSprint closes those, reusing every existing mechanism rather than replacing any of it.

## B. Preference Architecture

Unchanged data model (`notification_preference`, scoped by `userId`); unchanged enforcement point
(`NotificationService.resolveChannels`, called from `notify()` before any channel row is even created —
preferences affect event *fan-out*, never the underlying business event, satisfying requirement #14
directly). New: `setPreference` now records an audit event (optional `AuditService` dependency, mirrors
`PaymentWebhookService`'s established "cross-cutting concern that must never block the write it's
observing" pattern) capturing the real old→new transition, not just "something changed."

## C. Required vs Optional Notifications

Unchanged, verified not redesigned: `isCriticalNotificationType` remains the sole authority;
`resolveChannels` never consults `preferences.find` for a critical type — structural, not a runtime
check that could be forgotten. `setPreference` silently no-ops an attempted critical-type disable
(pre-existing) — a dedicated test now proves **no audit event is recorded either** for such an attempt,
since the underlying write never happened.

## D. Channel Preference Model

Unchanged: independent per-(type, channel) rows; disabling `sms` for a type has zero effect on that
type's `email`/`in_app` rows (already true, now covered by a dedicated grouped-history test proving the
canonical event's other channels are unaffected).

## E. SMS Consent / Eligibility Model

**New.** `NotificationService.getSmsEligibility(userId)` returns `{ phoneVerified, maskedPhone,
optedOut }`, resolved from the same verified-SMS-MFA-credential signal PRSprint 15's `getPhone()`
already uses (never re-derived, never a second notion of "verified") plus `sms_opt_out` lookup.
Combined with a live `smsProviderAvailable` flag (the exact same decision `getSmsSender()` itself makes,
reused via a newly-exported `computeSmsDeliveryStatus`, not duplicated), the preferences route returns
all three pieces of information needed to render an honest SMS control — never a plain checkbox that
implies capability the system doesn't have. Explicitly documented, not silently assumed solved: this is
the *best available* consent proxy in the current architecture (a deliberate MFA action, not passive
phone possession), not a dedicated marketing-style consent-versioning system — building one was
judged out of scope ("PRSprint 16 is not a marketing-consent sprint," the spec's own words).

## F. Provider Suppression Integration

`getSmsEligibility`'s `optedOut` field surfaces `sms_opt_out` (PRSprint 15) directly to the preferences
UI. The `NotificationPreferences` component disables (not merely defaults) the SMS checkbox and
explains why in plain language when opted out — the user cannot re-enable SMS delivery for themselves
through the ordinary preference toggle while carrier-suppressed; the underlying enforcement
(`NotificationService.deliver()`'s pre-send opt-out check, PRSprint 15, unchanged) already made this
structurally true regardless of preference state — this PRSprint only makes it *visible*, closing the
"misleading enabled toggle" gap requirement #11 named directly.

## G. Files Changed

**New:**
- `src/app/api/notifications/route.test.ts`, `src/app/api/notifications/preferences/route.test.ts`

**Modified:**
- `src/lib/notify/notificationService.ts` — `getSmsEligibility`, `listGroupedForUser`,
  `GroupedNotification`/`GroupedChannelStatus`/`SmsEligibility` types, optional `audit` dependency,
  `setPreference` audit trail.
- `src/lib/notify/getNotificationService.ts` — wires `AuditService`.
- `src/lib/notify/testFakes.ts` — in-memory audit fake, exposed via `createTestNotificationService`.
- `src/lib/admin/environmentStatus.ts` — `computeSmsDeliveryStatus` exported (was module-private).
- `src/app/api/notifications/route.ts` — returns `listGroupedForUser`, not raw `listForUser`.
- `src/app/api/notifications/preferences/route.ts` — returns `smsEligibility`/`smsProviderAvailable`
  alongside the existing `preferences` array.
- `src/components/NotificationCenter.tsx` (+ `.test.tsx`) — renders grouped entries with per-channel
  status chips (email/sms only — in_app is the card itself); "mark read" now targets the group's own
  `inAppId`.
- `src/components/NotificationPreferences.tsx` (+ `.test.tsx`) — SMS control now reflects eligibility
  (phone-unverified / opted-out / provider-pending / fully eligible), with a masked-phone confirmation
  line and a deep link to `/account/security` when verification is needed.
- `src/lib/ui/statusLabels.ts` (+ `.test.ts`) — **real bug fix**: `notificationEventLabel` was missing
  four PRSprint-13-added types (`agreement_invitation_response`, `agreement_action_required`,
  `agreement_decided`, `agreement_counterparty_signed`, `amendment_decided` — five, not four; corrected
  count), which previously rendered as their raw enum string in the Notification Center. New
  `notificationDeliveryStatusLabel` for per-channel status chips.
- `src/lib/auth/authService.test.ts` — the requirement #47 mandatory regression test.

## H. Database Changes

**None.** No migration in this PRSprint. Reused `notification_preference` (Sprint 17),
`audit_event` (Sprint 6A), `sms_opt_out` and `mfa_credential`'s existing `verifiedAt` (PRSprint 15) —
directly satisfying requirement #26 ("avoid duplicate delivery tables") and requirement #9 (existing
users need no migration/backfill: absence of a preference row already means "enabled" by established
design, unchanged). `supabase db push --linked --dry-run` confirms "Remote database is up to date."

## I. RLS / Security

No new table, so no new RLS surface. `notification_preference`/`notification_event`/`sms_opt_out` keep
their existing deny-all-for-anon/authenticated RLS (PRSprint 02/13/15 precedent). All three route
handlers derive `userId` exclusively from `requireSession` — never from a request body/query parameter
— verified directly by a new test that deliberately submits another user's id in the POST body and
confirms it's silently ignored (the caller's own session wins). Cross-user access is denied by
construction (every service method takes the caller's own userId as an explicit, session-derived
parameter) — verified by dedicated tests at both the service and route layer.

## J. User Settings UI

`/account/notifications` (`NotificationPreferences`) — every SMS control state (eligible-enabled,
eligible-disabled, phone-unverified, opted-out, provider-pending) renders distinct copy, no
"Twilio"/"provider"/infrastructure terminology anywhere (verified directly by a test asserting the
rendered text never contains those words). A verified phone shows only its last two digits.

## K. Notification History UI

`/notifications` (`NotificationCenter`) — one card per logical notification (`groupId`), with
email/sms shown as small status chips reading "Sent"/"Delivered"/"Could not send"/"Not sent" (never
"provider_accepted"/"bounced"/other infrastructure terms); in_app is not shown as a redundant chip
since the card itself already represents it. Pagination (existing, unchanged, 20/page), newest-first
ordering (existing, unchanged), empty state (existing, unchanged).

## L. Delivery Status Model

No new states — reuses `pending`/`sent`/`delivered`/`failed` (PRSprint 14/15) plus a UI-only
`"not_sent"` (never persisted; computed when a channel was eligible for the type but has no row,
distinguishing "disabled by your notification preference" from a generic "not applicable" for
historical rows created before that channel existed for that type — e.g. before PRSprint 15 added
`sms` to five types). "Sent" and "delivered" remain distinct, never conflated (PRSprint 14/15's own
correction, preserved and now visible to the user for the first time).

## M–Z. Tests, Regressions, CI, Verification

See below.

## Test Results

- New/updated tests: `notificationService.test.ts` (+20 PRSprint 16 tests — audit trail, grouping,
  eligibility), `statusLabels.test.ts` (+2), `authService.test.ts` (+1, the mandatory #47 regression),
  `NotificationCenter.test.tsx` (rewritten for the grouped shape, +2 new), `NotificationPreferences.test.tsx`
  (rewritten, +4 new eligibility-state tests), two new route test files (9 tests).
- Full suite: **1147/1147 passed** (154/154 files, zero flakes).
- Typecheck: clean. Lint (every changed/new file): clean, 0 errors/warnings.
- Production build: succeeded.

## M. Email Preference Test

Verified via `notificationService.test.ts`'s existing (PRSprint 13/14) coverage plus the new grouping
test "does not suppress the canonical event's other channels just because one channel is disabled":
disabling `amendment`/`email` produces no email row on the next `notify()` call while `in_app` still
delivers normally; re-enabling restores email delivery on the following event. PASS.

## N. Required Email Regression Test

**Mandatory per requirement #47 — PASS.** New test in `authService.test.ts`: every non-critical
notification-preference email category is explicitly disabled for a user id, then
`AuthService.requestPasswordReset` is called for a *different* test user — the reset email still
sends (`sentBefore + 1`, correct subject). This is not a coincidence of test setup: `AuthService`
calls its own `EmailSender` directly and has never gone through `NotificationService`/preferences at
all (confirmed in PRSprint 14's own investigation) — the test makes that architectural guarantee
explicit and regression-proof rather than leaving it merely inferred.

## O. SMS Preference Test

Using the existing mocked `SmsSender` fake (Twilio activation pending — no live send claimed):
eligible phone + SMS enabled → event produces an sms row and a send attempt; preference disabled before
the next event → no sms row created at all (not merely "delivery skipped" — the row itself doesn't
exist, satisfying requirement #14's "affects delivery channel eligibility" framing precisely); email
remains unaffected throughout. PASS.

## P. STOP/Suppression Test

`getSmsEligibility` correctly reports `optedOut: true` once a phone is recorded in `sms_opt_out`
(PRSprint 15's own inbound-webhook path, unchanged); the preferences UI disables the SMS control and
explains the state; `NotificationService.deliver()`'s pre-send suppression check (PRSprint 15,
unchanged, re-verified in this PRSprint's full-suite run) means no ordinary preference update can
cause a send to a suppressed number — verified end-to-end: opted-out + preference "enabled" still
never reaches `smsSender.send()`. PASS.

## Q. Notification History Test

New dedicated tests: correct grouping (one entry per `notify()` call, keyed by the universal
dedupeKey-minus-channel convention — audited directly against every real call site in this codebase,
not assumed); correct ordering (newest-first, unchanged); correct labels (the five-type
`notificationEventLabel` gap fix); correct channel states including the "disabled by preference"
distinction; no raw payload/provider metadata ever rendered (component only ever reads
`notificationType`/`channels[].status`/`channels[].reason`, never `payload` beyond the existing
template-rendering path); pagination unchanged/still covered; cross-user isolation verified at both
service and route layers. PASS.

## R. Cross-User/Tenant Test

Verified directly: `listGroupedForUser`/`getSmsEligibility`/`setPreference` each take the target
user id as an explicit parameter with no cross-user code path; the route layer derives that parameter
exclusively from `requireSession`, and a new test proves a request body attempting to smuggle another
user's id is silently ignored. `markRead` (pre-existing, PRSprint 18B) already denies cross-user reads,
re-verified unchanged. No route or service method anywhere accepts a client-supplied recipient/target
identity for a mutation. PASS.

## S. Auth Regression

Full pre-existing suite unaffected: `authService.test.ts` (34/34, including the new #47 test),
`mfaService.test.ts`, `crossAccountIsolation.test.ts`, `session.test.ts` — all still passing.

## T. Admin Regression

`adminService.test.ts`, `adminRoleService.test.ts`, `retentionHoldService.test.ts`,
`emailDeliveryAdminService.test.ts`, `smsDeliveryAdminService.test.ts` — all still passing, unmodified
in behavior. No admin capability, route, or page was touched by this PRSprint.

## U. PRSprint 15 Regression + Pending Twilio Status

`twilioSmsSender.test.ts`, `verifyTwilioWebhookSignature.test.ts`, `phone.test.ts`,
`smsDeliveryAdminService.test.ts` — all still passing, unmodified in behavior. Opt-out structures
(`sms_opt_out`, the inbound webhook) and idempotency (dedupe keys, `redeliverFailedEvent`'s
not-currently-failed guard) unchanged and re-verified. **Twilio production activation remains
EXTERNALLY BLOCKED** — the Product Owner's A2P/compliance registration is still pending; this PRSprint
does not claim, and did not attempt, any live carrier-delivered SMS. `getSmsSender()` still returns
`ConsoleSmsSender` in production. PRSprint 15 is **not** being marked fully production-verified as
part of this PRSprint — that determination belongs to PRSprint 15's own tracker row and requires a
real controlled send once Twilio approval exists.

## V. PRSprint 14 Regression

`resendEmailSender.test.ts`, `verifyResendWebhookSignature.test.ts`, `emailTemplateShell.test.ts`,
`emailDeliveryAdminService.test.ts` — all still passing. Production email path untouched by this
PRSprint's code changes.

## W. PRSprint 13 Regression

Event taxonomy unchanged (no type added/removed/reclassified — `notificationEventLabel`'s fix is a
presentation-layer addition, not a taxonomy change). Recipient resolution, event idempotency, and
business/event decoupling all unchanged and re-verified by the full passing suite. No second event
pipeline was created — `listGroupedForUser` reads the exact same `notification_event` rows
`listForUser` already did, purely a presentation-layer regrouping.

## X. PRSprint 12/12A Regression

Signatures/PDFs/amendments: unmodified, all relevant suites still passing. Rate limiting:
`rate-limit.test.ts` still passing. Schema/migration integrity: confirmed below.

## Y. CI Results

Lint/typecheck/full test suite (1147/1147) all green locally; GitHub Actions CI run reported separately
in the tracker/PR.

## Z. Supabase Verification

- Correct linked project: `lmpicrmmixpvkwwhcxbh` ("Paid2You", ACTIVE_HEALTHY).
- `supabase migration list --linked`: all 30 migrations `local == remote` — unchanged from PRSprint 15
  (no new migration in this PRSprint).
- `supabase db push --linked --dry-run`: "Remote database is up to date."

## AA. Vercel Verification

See the chat completion report (post-merge) for the live production sweep.

## AB. Migration / Schema Drift Verification

No migration in this PRSprint. Verified zero drift both before and after this PRSprint's own code
changes (schema itself untouched).

## AC. Git Information

See the chat completion report for branch/commit/PR/CI/merge/sync details.

## AD. Remaining Issues (not concealed)

1. **Twilio production activation remains externally blocked** (PRSprint 15's own status, carried
   forward unchanged — not resolved, not claimed resolved, by this PRSprint).
2. SMS consent remains a *proxy* (verified MFA phone), not a purpose-built consent-versioning system —
   documented as a deliberate, narrow scope decision, not silently assumed sufficient forever; a
   candidate for a future dedicated consent sprint if product requirements demand a formal record
   beyond what's built here.
3. `listGroupedForUser`'s grouping relies on every `notify()` caller supplying a `dedupeKey` — true for
   100% of call sites today (audited directly), with a defensive per-row fallback if that invariant
   ever changes, but not schema-enforced (a future caller could theoretically omit one, causing that
   specific notification to render as N separate cards instead of one — narrow, defensive-only risk,
   not observed in current code).
4. `computeSmsDeliveryStatus` is imported by a user-facing route (`/api/notifications/preferences`)
   from the `admin` module where it was originally defined for PRSprint 14/15's admin environment
   view — a minor, deliberate cross-module reuse to avoid duplicating the exact provider-availability
   decision, not a privilege leak (the function is pure and reads no admin-authorized data).
