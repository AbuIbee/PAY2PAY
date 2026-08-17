# PRSprint 13: Notification Event Wiring

## Trigger

Next PRSprint in the numbered sequence, authorized after PRSprint 12A's merge. Objective: establish
a reliable, auditable, idempotent notification event layer converting meaningful Paid2You business
events into notification-ready records, without coupling application logic to production email/SMS
providers.

## Targeted audit: what already existed vs. what was actually missing

A mature, production-grade notification infrastructure already existed (Sprint 17/18/18A, PRSprint
10): a canonical `NotificationEventType` taxonomy (`eventTypes.ts`), `NotificationService.notify()`
with built-in idempotency (caller-supplied `dedupeKey`, combined with channel, returns the existing
row on a repeat call instead of sending again), retry semantics (attempt tracking, exponential
backoff via `nextRetryAt`, max-attempts exhaustion), critical-vs-preference-filtered channel
resolution, and code-based templates. This is already exactly the "transactional-outbox-equivalent"
architecture PRSprint 13's own spec asks for (persisted event, type, payload, status, retry-safe
identifier, idempotency key, attempt tracking) — reviewed and confirmed adequate, not rebuilt.

**The real, concrete gap**, found by grepping every production call site of
`NotificationService.notify(`: the invitation layer (`AgreementInvitationService`,
`RelationshipService`, `RelationshipInvitationService`, `RelationshipFinancialAccountService`), the
appeal service, and the payment webhook/failed-payment-workflow services were all already wired — but
**`AgreementService`, `AmendmentService`, and `SignatureService` — the three services that actually
drive an agreement/amendment/signature through its state machine once it exists — had zero
notification calls anywhere**, despite `agreement_signed` and `amendment` already existing in the
taxonomy since Sprint 17/PRSprint 11 for exactly this purpose. `amendment` in particular was
completely dead: defined, fully wired for delivery/templates/dedup, never once called.

## Architecture

Unchanged core principle, now actually honored end-to-end: business-domain logic never sends email/SMS
directly. Every one of this PRSprint's new notification calls goes through the existing
`NotificationService.notify()` — none of the three newly-wired services touch `EmailSender`/`SmsSender`
directly, and none gained a new persistence mechanism of their own. `notifications` is an **optional**
dependency on all three (`AgreementServiceDeps`, `AmendmentServiceDeps`, `SignatureServiceDeps`),
mirroring the exact precedent already established by `PaymentWebhookService`'s own
`notifications?`/`profileOwners` pair — every existing test that omits it is unaffected, and every new
call is wrapped in its own try/catch, logged on failure via the existing structured logger, never
re-thrown (failure isolation — see below).

## Files Changed

- `src/lib/notify/eventTypes.ts`, `src/lib/notify/templates.ts`: four new `NotificationEventType`
  values and their templates (see Event Taxonomy below). No schema change — `notification_type` is
  already a free-text column (`src/db/schema/notify.ts`), confirmed before adding these.
- `src/lib/agreements/agreementService.ts`, `getAgreementService.ts`, `testFakes.ts`: wired
  `submitDraft`/`acknowledgeDebt`/`creditorDecide` (accept/reject/counter); `recordAudit` now returns
  the created audit event's id, used as the notification dedupeKey's per-round uniqueness marker.
- `src/lib/amendments/amendmentService.ts`, `getAmendmentService.ts`, `testFakes.ts`: wired
  `proposeAmendment`, `decideAmendment` (accept/reject/counter), `signAmendment` (first-signer),
  `applyAmendment` (full application); gained a new required `profileOwners` dependency (mirrors
  `AgreementService`'s own) and optional `notifications`.
- `src/lib/signatures/signatureService.ts`, `getSignatureService.ts`, `testFakes.ts`: wired `sign()`
  for both the "counterparty needs to sign" and "fully executed" moments.
- `src/lib/agreementInvitations/agreementInvitationService.test.ts`, `src/lib/amendments/*.test.ts`,
  `src/lib/disputes/testFakes.ts`, `src/lib/signatures/signatureService.test.ts`: updated the (now six)
  existing test call sites that construct `AmendmentService` directly to supply the new required
  `profileOwners` dependency — mechanical, no behavior change to what those tests exercise.

## Database Changes

**None.** `notification_event`/`notification_preference` already had every column this PRSprint needed.
No migration file was created; `supabase db push --linked --dry-run` (re-run after all code changes)
confirms nothing pending — migration integrity, the protected regression boundary PRSprint 12A
established, is untouched.

## Event Taxonomy (new)

- `agreement_action_required` — the *other* party must now act: submitted → debtor must acknowledge;
  acknowledged → creditor must decide; countered → debtor must review new terms.
- `agreement_decided` — the creditor's accept/reject decision, told to the debtor.
- `agreement_counterparty_signed` — one party has signed and the other has not yet; reused for both
  the main agreement and an amendment's own signature step (`payload.context` distinguishes copy).
- `amendment_decided` — the counterparty's accept/reject decision on a proposed amendment, and the
  amendment's own completion ("now applied, a new version is active") — told to the proposer.

All four non-critical (mirror `amendment`'s own classification — each still requires the recipient to
actively review/sign/decide within its own workflow, so a missed notification specifically doesn't let
anything happen unnoticed).

## Event Sources

| Notification | Fired from | When |
|---|---|---|
| `agreement_action_required` | `AgreementService.submitDraft` | after status → `awaiting_debtor_acknowledgment` |
| `agreement_action_required` | `AgreementService.acknowledgeDebt` | after status → `awaiting_creditor_acceptance` |
| `agreement_decided` | `AgreementService.creditorDecide` (accept/reject) | after status update + audit |
| `agreement_action_required` | `AgreementService.creditorDecide` (counter) | after terms/schedule/status updated |
| `amendment` | `AmendmentService.proposeAmendment` | after the amendment row is inserted |
| `amendment` | `AmendmentService.decideAmendment` (counter) | after the counter-terms are recorded |
| `amendment_decided` | `AmendmentService.decideAmendment` (accept/reject) | after status update |
| `agreement_counterparty_signed` | `AmendmentService.signAmendment` (first signer) | after the signature is recorded |
| `amendment_decided` (decision: applied) | `AmendmentService.applyAmendment` | after the atomic apply commits |
| `agreement_counterparty_signed` | `SignatureService.sign` (first signer) | after the atomic signing commits |
| `agreement_signed` | `SignatureService.sign` (second/completing signer) | after the atomic signing commits |

Every call happens strictly *after* its underlying write already succeeded — never before, never
interleaved.

## Recipient Resolution

Every recipient is resolved server-side via `ProfileOwnerReader.getOwnerUserId(profileKind,
profileId)` against the agreement's own `creditorProfileKind`/`creditorProfileId`/
`debtorProfileKind`/`debtorProfileId` columns — never a client-supplied user id. For a business
profile, this resolves to the business's **owner** account only, never fanning out to every staff
member (verified by a dedicated test: a business-debtor agreement's `submitDraft` notifies only the
owner). Payer↔receiver / inviter↔invitee / debtor↔creditor resolution is exercised directly by the new
tests for each of the three services' call sites (each explicitly asserts the *opposite* role from the
actor is the one notified, and that the actor is *not* separately notified of their own action).

## Unregistered Invitees

Unchanged — this PRSprint's three newly-wired services only ever operate on an already-canonical
`agreement` row, which by construction (PRSprint 10) requires both `creditorProfileId`/
`debtorProfileId` to already resolve to real, registered profiles. The pre-agreement, possibly-
unregistered-recipient window is entirely `AgreementInvitationService`'s domain, already wired
(Sprint 17/PRSprint 10, unchanged by this PRSprint).

## Idempotency

Unchanged `NotificationService.notify()` mechanism, now actually exercised end-to-end by three more
callers: each dedupeKey is scoped to `{type}:{agreementId}:{auditEventId | signatureEventId}:
{recipientUserId}`, using the *specific audit/signature event this call is reporting on* — never a
static composition of just type+agreement+status — as its uniqueness marker. This is deliberate:
an agreement/amendment can legitimately cycle through the same statuses multiple times across a
multi-round negotiation, so a coarser key would wrongly deduplicate away later, equally-legitimate
rounds (verified directly: a new test proposes-counters twice and confirms two distinct notifications,
not one).

## Transactional Integrity / Failure Isolation

Every new notification call is the *last* thing its method does, after every state-machine write has
already committed (mirrors `PaymentWebhookService.notifyPaymentStatus`'s own established placement).
Each is wrapped in its own try/catch; a thrown error is logged via the existing structured logger and
never re-thrown, so a notification-layer outage can never fail, roll back, or retry the business
transaction it was reporting on — verified directly for all three services (a fake `notifications`
whose `notify()` always throws; the underlying `submitDraft`/`sign`/`proposeAmendment` call still
resolves successfully and the state-machine write is still visible afterward).

## Security / RLS

No new table, so no new RLS surface. `notification_event`/`notification_preference` already had RLS
enabled with zero policies (deny-all for anon/authenticated; the app's own connection uses the
owner/BYPASSRLS role), matching this codebase's already-audited (PRSprint 02) architecture — unchanged.
Recipient/type/payload are always server-derived (never accepted from a client anywhere in this
codebase — no route exists that lets a caller supply `recipientUserId`/`notificationType` directly to
`notify()`), so "a client claiming `eventType = agreement.executed`" (the required unauthorized-event
scenario) is structurally impossible, not merely untested: there is no code path for it to enter
through.

## Tests

- `agreementService.test.ts`: +8 (26 total) — recipient resolution for each of
  submit/acknowledge/accept/reject/counter, business-owner resolution, multi-round non-deduplication,
  failure isolation, no-notification-on-a-rejected-attempt.
- `amendmentService.test.ts`: +5 (21 total) — propose/accept/reject/sign/apply recipient resolution
  and failure isolation.
- `signatureService.test.ts`: +3 (19 total) — counterparty-signed vs. both-signed recipient
  resolution, failure isolation.
- Full suite: 970/970 passed (up from 954 — 16 net new, no regressions).

## Required Test Matrix (per this PRSprint's own spec)

- **Invitation test**: unchanged — already covered by `AgreementInvitationService`'s own existing,
  passing test suite (invitation creation/claiming was already wired before this PRSprint).
- **Agreement approval test**: PASS — see `agreementService.test.ts`'s new describe block; propose →
  correct notification → counterparty acts → correct next notification, with no premature
  signature/execution event.
- **Signature test**: PASS — see `signatureService.test.ts`'s new tests; correct signer notified
  first, correct both-party notification on execution, no duplicate execution event (existing PDF-
  exactly-once test, unchanged, still passing).
- **Amendment test**: PASS — see `amendmentService.test.ts`'s new tests; proposal → counterparty
  notified → decision → proposer notified → signatures → applied notification to both, with version
  references correct throughout (unchanged PRSprint 12 carry-forward test still passing).
- **Concurrency/replay**: covered by the existing atomic-signing-path tests (PRSprint 12) plus the new
  multi-round non-deduplication test — the underlying state-machine writes this PRSprint's
  notifications report on were already made atomic/idempotent in PRSprint 12; this PRSprint adds no
  new concurrency surface of its own (`notify()`'s own dedupe-by-key already handled replay before
  this PRSprint).
- **Unauthorized event tests**: structurally satisfied — no route or method anywhere accepts a
  client-supplied recipient/type/agreement-version for a system notification; every new call site
  re-derives everything from server-side state, matching every other authorization boundary in this
  codebase.

## Deliberately left as-is / out of scope (with rationale)

- **Admin visibility** (spec's own "review whether — do not redesign the Admin Console beyond what is
  necessary"): not built. The existing admin audit-log lookup already covers `agreement`/`business_
  profile`/`user_account`/`support_case` target types generically; adding a dedicated notification-
  event admin view is a real, standalone feature, not a "necessary for PRSprint 13" requirement — the
  spec's own phrasing frames this as discretionary, and building it now risks exactly the "redesign
  beyond what is necessary" the spec warns against. Notification-layer failures remain fully
  observable via the existing structured `logger.error` calls (searchable in production logs), so this
  is not a blind spot — just not a dedicated UI yet.
- **Production email/SMS providers**: not touched — `ConsoleEmailSender`/`ConsoleSmsSender` remain the
  only implementations, per this PRSprint's own explicit "do not overreach" instruction. PRSprints
  14/15's stated scope.
- **Notification preferences UI / user-facing delivery history**: not touched — `NotificationService.
  setPreference`/`getPreferences`/`listForUser` already exist (Sprint 18B) and are unchanged; PRSprint
  16's stated scope.

## PRSprint 12A production-integrity regression (requirement #38)

- `supabase migration list --linked`: unchanged, all migrations `local == remote`.
- `supabase db push --linked --dry-run`: "up to date" — confirmed after this PRSprint's own (migration-
  free) changes.
- Verified live in production (see Vercel Verification in the completion report): `rate_limit_bucket`
  writes succeed with no `rate_limit_store_unavailable` errors; `/api/health` still reports
  `"environment":"production"`.

## CI / quality gate

- Typecheck: clean. Lint (every changed/new file): clean.
- Full suite: 970/970 passed.
- Production build: succeeded.
