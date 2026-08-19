# PAY2PAY Backup, Recovery, Rollback & Incident Controls

**PRSprint 29** (`docs/prsprints/PRSPRINT_29_BACKUPS_RECOVERY_ROLLBACK_INCIDENT_CONTROLS.md`)
**Date:** 2026-08-19
**Status of this document:** operational runbook — read alongside `docs/prsprints/PHASE_7_COMPLETION_REPORT.md`
§ PRSprint 29 for the verification evidence behind each claim below.

## 1. Database backup status — VERIFIED, NOT SATISFACTORY

Checked directly against the linked production Supabase project (`Paid2You` / `lmpicrmmixpvkwwhcxbh`,
`ca-central-1`) via `supabase backups list`:

```json
{"region":"ca-central-1","walg_enabled":true,"pitr_enabled":false,"backups":[],"physical_backup_data":{}}
```

- `walg_enabled: true` — the underlying WAL-G backup engine is present on the instance.
- `pitr_enabled: false` — **point-in-time recovery is NOT enabled.**
- `backups: []` — **zero backups currently exist for this project.**

**This is a genuine, disclosed production-readiness gap, not a documentation-only shortfall.** Enabling
PITR/scheduled backups on Supabase is a project-plan/billing feature configured through the Supabase
dashboard (or an organization-level plan upgrade) — the Supabase CLI has no `backups enable` command,
and enabling it is an account/billing change outside what this session is authorized to perform
unilaterally (a plan/billing change requires the Product Owner's own action, consistent with this
project's "changing account settings requires explicit permission" rule).

**EXTERNAL BLOCKER — PRODUCT OWNER ACTION REQUIRED**: enable Point-in-Time Recovery (or, at minimum,
scheduled daily backups) on the linked Supabase project. Until this is done:

- There is no way to recover the production database from accidental data loss, a bad migration, or
  a compromised/corrupted write beyond what a manual `pg_dump` (not currently scheduled) would capture.
- **A backup-restore test cannot be performed** — there is nothing to restore. Per this PRSprint's own
  Hard Stop rule ("Stop if backup restore cannot be proven or no viable recovery path exists"), this
  finding is escalated here rather than a restore test being fabricated or skipped silently.

**Recommended immediate action for the Product Owner**: enable PITR on the Supabase project (Pro plan
or above) and confirm a first successful backup appears in `supabase backups list`. Once available,
this document's §4 (Financial Recovery) and a real restore-to-a-branch test become possible and should
be performed before any real customer funds move through this system.

## 2. Application/deployment rollback — VERIFIED, WORKING

Unlike the database, application rollback is real and already proven throughout this project's own
history:

- **Vercel deployments are immutable and independently addressable.** Every production deploy this
  session has performed (Phase 5/6/6A/7) is still listed via `vercel ls pay-2-pay --prod` with its own
  stable URL; `vercel rollback` (or promoting a prior deployment via the Vercel dashboard/CLI) points
  production traffic at any previous immutable build without a new code change.
- **CI runs on every push/PR to `master`** (lint/typecheck/test/build, a fresh-database migration
  test, and — on the `master` push specifically — the Supabase schema drift check; see
  `docs/OPERATIONS_CI_CD.md` §1). **Correction (PRSprint 30):** this section previously claimed a bad
  deploy "requires... a CI failure to have been bypassed (it can't be, on the required branch)" — that
  was inaccurate. PRSprint 30 checked directly (`gh api repos/AbuIbee/PAY2PAY/branches/master/
  protection`) and found `master` has no branch protection configured at all: CI is visible but not
  currently enforced as a merge/push gate. See `docs/OPERATIONS_CI_CD.md` §2 for the full finding and
  the options flagged for Product Owner decision. Rollback itself is unaffected by this: "promote the
  previous Vercel deployment" requires no database change and is safe by construction regardless of
  how a bad deploy got there (see §4).
- **Migration rollback strategy**: this project has no automated "down" migrations (standard for this
  codebase's drizzle-kit-generated migration style — every migration to date has been additive:
  new tables/columns, never a destructive `DROP`/`ALTER ... TYPE` that would need reversing). The
  practical rollback strategy for a bad migration is **forward-fix**, not down-migration: write a new,
  small, additive migration that corrects the problem, matching how every PRSprint in this project's
  history has already operated. A migration that ever needs to be genuinely destructive (a `DROP
  COLUMN`, a type narrowing) should be preceded by a Product-Owner-reviewed plan — none has been
  required so far.

## 3. Incident severity categories

| Severity | Definition | Example | Response |
|---|---|---|---|
| **SEV-1 (Critical)** | Real customer funds at risk, cross-tenant financial data exposure, authentication bypass, raw banking credential exposure. | A provider webhook signature check is bypassable; a routing/account number is found persisted. | Immediate kill-switch activation (§5) for the affected capability; Product Owner notified immediately; no further deploys until root-caused. |
| **SEV-2 (High)** | Payment processing degraded/failing, a single tenant's data exposed to another, a dependency (DB/provider/email/SMS) outage. | Supabase unreachable; Resend/Twilio outage; a reconciliation exception spike. | Kill switch for the affected capability if it prevents further harm; `GET /api/admin/health` consulted; Product Owner notified within the incident window. |
| **SEV-3 (Medium)** | A non-financial feature degraded, a UI regression, elevated (but not total) error rates. | Notification delivery delayed; a search endpoint slow. | Tracked, fixed on the next normal deploy cycle; no kill switch needed. |
| **SEV-4 (Low)** | Cosmetic, non-blocking, no customer impact. | A label typo. | Tracked, fixed opportunistically. |

**Database outage**: `GET /api/admin/health` reports `database: "unreachable"` (§ PRSprint 28) —
this is the first diagnostic step. No automatic failover exists (single Supabase instance); recovery is
"wait for Supabase to restore service" until PITR (§1) makes a restore-to-a-different-instance option
viable.

**Provider outage** (payment/KYC/card sandbox provider): today's sandbox providers have no external
network dependency (`SandboxPaymentProvider`'s own doc comment: "nothing here ever reaches a real
network"), so a provider "outage" in the current sandbox-only state is not a real production risk.
When a live provider is selected (`docs/PRODUCTION_PROVIDER_READINESS.md`), this section must be
revisited — the kill switches in §5 are the intended response mechanism.

**Suspected security incident**: rotate the affected secret in Vercel immediately (production +
development), invalidate active sessions if session/credential compromise is suspected (existing
`AuthService`/session-revocation architecture, PRSprint 06), review `audit_event` for the affected
resource, and consider the relevant kill switch (§5).

**Bad deployment**: promote the previous Vercel deployment (§2); no database change needed for a
pure-application-layer bug given every migration to date is additive.

**Schema migration problem**: forward-fix (§2); if a migration is mid-flight and has partially applied,
Supabase's own transaction-wrapped migration application (`supabase db push`) means a failed migration
does not leave the schema half-changed — it fails atomically.

**Cross-tenant access issue**: this is a SEV-1 by definition (§ above) — disable the affected write path
via the nearest applicable kill switch, and audit `audit_event`/RLS policy state for the affected table
immediately; every table in this project's schema is `.enableRLS()`'d with deny-all-for-anon/
authenticated as the default posture (PRSprint 02), so a cross-tenant read/write finding indicates an
application-layer authorization bug, not a missing RLS policy — start there.

**Compromised secret**: rotate in Vercel (production + development; preview is a documented,
non-blocking known CLI limitation — see `docs/prsprints/PHASE_6_COMPLETION_REPORT.md` §8), redeploy,
and confirm via the same before/after `curl` pattern this project has used for every prior secret fix.

**Webhook backlog/replay issue**: safe by construction — every webhook path (`payment_webhook_event`/
`kyc_webhook_event`/`card_transaction_event`) is deduplicated on `(provider, provider_event_id)` via a
DB unique constraint before being applied (Sprint 9/PRSprint 21-24's established pattern); a replayed
backlog re-processes idempotently, never double-applying a financial effect.

## 4. Financial recovery

**A database restore must never create duplicate financial events.** This project's architecture
already guarantees this independent of whether/when a restore ever happens:

- Every payment-affecting webhook event is deduplicated on `(provider, provider_event_id)` before its
  effect is applied (§3, webhook backlog).
- Every ledger journal entry is deduplicated on `(payment_attempt_id, entry_type)` — a re-applied event
  after a restore-to-an-earlier-point finds the existing row and does not post again (Sprint 10/Phase 5).
- The ledger is append-only (no `update`/`delete` method exists on `LedgerJournalEntryRepository`/
  `LedgerPostingRepository`) — a restore that rewinds to before a correction was made would simply be
  missing that correction's row, not have conflicting/duplicated ones; re-running reconciliation
  (`ReconciliationService`) after any restore would surface the gap as an exception for manual review,
  never silently double-count.
- Provider events that arrived after the restore point (real, in the outside world, but "in the future"
  relative to the restored database) are exactly what the existing replay-safe webhook path is designed
  to re-absorb correctly — this is the same mechanism that already protects against a provider's own
  retried delivery, requiring no restore-specific special case.

**This reasoning is architecturally sound but has not been exercised against a real restore**, because
no backup exists to restore from (§1). Once PITR is enabled, a restore-to-a-Supabase-branch drill
(never a destructive production restore — Supabase branching allows testing a restore without touching
the live database) should be performed to prove this empirically, not just architecturally.

## 5. Kill switches (PRSprint 29, this session)

Two new operational feature flags (`src/lib/feature-flags.ts`), each overridable via a Vercel
environment variable with no deploy required, each defaulting to normal operation (`true`):

| Flag | Env override | Enforced in | Effect when disabled |
|---|---|---|---|
| `paymentInitiationEnabled` | `FEATURE_PAYMENT_INITIATION_ENABLED=false` | `PaymentService.reserveAttempt` (the single choke point every payment-creation path already goes through) | New payment creation is rejected (503 `DEPENDENCY_UNAVAILABLE`). A retried idempotency key for an *already-created* payment still returns its existing result — the switch never blocks a replay, only genuinely new activity. Historical records untouched. |
| `bankConnectionEnabled` | `FEATURE_BANK_CONNECTION_ENABLED=false` | `BankConnectionService.connectBankAccount` (the one place a new bank connection is ever created) | New bank-account connections are rejected (503). Already-connected accounts, and their use for existing ACH mandates, are unaffected. |

Both are proven by dedicated tests (`paymentService.test.ts`, `bankConnectionService.test.ts`) — the
switch actually blocks the action, and actually does not block an already-resolved replay.

**Pre-existing kill switches, confirmed via audit, not newly built**: `EMAIL_DELIVERY_ENABLED`/
`SMS_DELIVERY_ENABLED` (PRSprint 14/15 — a communications kill switch, defaulting to console-log-only
until explicitly enabled) and `liveBankingEnabled`/`liveCardIssuanceEnabled` (Phase 6 — always `false`
today, the mechanism that keeps live financial capability from ever activating by accident).

**Not built this pass**: a broad "maintenance/read-only mode" switch spanning the whole application.
Given the two capability-specific switches above already cover the two genuinely money-moving write
paths, and a full read-only mode would need to touch dozens of unrelated write endpoints
(staff management, notifications, support cases) for comparatively little incident-response value, this
is recorded as a reasonable, documented deferral rather than built to hit a checklist item.

## 6. Customer outage/status messaging

No dedicated public status page exists. Given Phase 7's closed-beta scope (PRSprint 33) and this
project's current pre-production stage, the existing `/support` page (`SupportAppeals.tsx`, already
built) is the customer-facing incident-communication surface — a real status page is a reasonable
follow-up once real customer traffic exists, not a blocker for controlled closed-beta entry.
