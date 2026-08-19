# PAY2PAY Production Launch Runbook

PRSprint 33 (docs/prsprints/PRSPRINT_33_FINAL_PRODUCTION_LAUNCH_CONTROLS_CLOSED_BETA.md), master-spec
item 130: "Create production launch runbook — who deploys, who can roll back, provider contacts,
Supabase recovery, Vercel recovery, incident response, emergency feature disable." This consolidates
what already exists across `docs/OPERATIONS_BACKUP_RECOVERY.md` (PRSprint 29) and
`docs/OPERATIONS_CI_CD.md` (PRSprint 30) into one place, plus fills the pieces neither of those covers.

## 1. Who deploys, who can roll back

This project deploys via Vercel's GitHub integration — pushing to `master` triggers a production
deploy automatically; there is no separate manual deploy step. **Who is authorized to push to
`master`, and who holds Vercel/Supabase account access to perform a rollback, is a Product Owner
decision this document cannot make** — see `docs/OPERATIONS_CI_CD.md` §2 for the related finding that
`master` currently has no branch protection at all, and the three options recorded there for deciding
who can merge/push.

Rollback mechanics (already verified working, PRSprint 29): `docs/OPERATIONS_BACKUP_RECOVERY.md` §2 —
every prior production deploy is an immutable, independently-addressable Vercel deployment;
`vercel rollback` or promoting a prior deployment via the dashboard points production traffic at any
previous build with no code change and no database change required.

## 2. Provider contacts

**Not filled in — this is real account/contact information only the Product Owner has, not something
inferable from code.** Before a real launch, this section needs:

| Provider | Role | Account owner | Support contact | Notes |
|---|---|---|---|---|
| Vercel | Hosting/deploy | _TBD_ | _TBD_ | |
| Supabase | Database | _TBD_ | _TBD_ | See §3 below — PITR/backups are currently disabled (PRSprint 29 finding) |
| Resend | Production email | _TBD_ | _TBD_ | PRSprint 14 |
| Twilio | Production SMS | _TBD_ | _TBD_ | PRSprint 15 |
| Payment processor | ACH/card processing | _TBD — none is live yet_ | _TBD_ | `liveBankingEnabled`/`liveCardIssuanceEnabled` both default false (src/lib/feature-flags.ts) |

## 3. Supabase recovery

`docs/OPERATIONS_BACKUP_RECOVERY.md` §1 has the full, previously-disclosed finding: the linked
production Supabase project has PITR disabled and zero backups (`pitr_enabled: false`, `backups: []`,
confirmed directly against the project). This is an **EXTERNAL BLOCKER — PRODUCT OWNER ACTION
REQUIRED** carried forward unchanged by this runbook, not resolved by it.

## 4. Vercel recovery

Covered in full at `docs/OPERATIONS_BACKUP_RECOVERY.md` §2 and this runbook's §1 above — immutable
deployments, no-code-change rollback via `vercel rollback` or the dashboard.

## 5. Incident response

`docs/OPERATIONS_BACKUP_RECOVERY.md` §3 has the full incident-severity table (SEV-1 through SEV-4) and
§4 has financial-recovery reasoning (webhook/ledger dedup makes a restore duplicate-safe by
construction). Not duplicated here — see that document directly.

## 6. Emergency feature disable (kill switches)

`docs/OPERATIONS_BACKUP_RECOVERY.md` §5 and `src/lib/feature-flags.ts` — `paymentInitiationEnabled`
and `bankConnectionEnabled` (PRSprint 29) can each be flipped off via a `FEATURE_*` env var in Vercel
with no deploy required, halting new activity of that kind immediately without affecting historical
records or already-in-flight work. `closedBetaEnabled` (PRSprint 33, this sprint) can similarly be
flipped on mid-incident to stop new signups entirely if needed (e.g., to contain a signup-abuse
incident) without a deploy.

## 7. Launch phasing (master-spec items 153, 199)

The mechanism now exists (PRSprint 33): `FEATURE_CLOSED_BETA_ENABLED=true` requires a valid, admin-
issued, single-use invite code (`POST /api/admin/beta-invites`, platform-admin-only) at signup — see
`src/lib/compliance/betaInviteService.ts`. This supports the master spec's phased pattern (internal
test users → restricted closed beta → limited volume → expanded beta → broader launch) by controlling
*who* can create an account at each phase; it does not by itself implement graduated volume limits
across phases (see `src/lib/payments/transactionLimits.ts` for the separate, flat per-payment cap that
applies regardless of phase).

## 8. Known limitations, carried forward honestly rather than silently resolved

- Provider contacts (§2) are template placeholders — Product Owner input required.
- Who may push to `master` / perform a rollback (§1) is undecided — see `docs/OPERATIONS_CI_CD.md` §2.
- Supabase PITR/backups (§3) remain disabled — EXTERNAL BLOCKER, unchanged by this PRSprint.
- Only a per-payment amount cap is enforced (`getMaxPaymentMinorUnits`); no daily/rolling-window
  account limit exists yet — would need a new aggregate-query repository method (see
  `src/lib/payments/transactionLimits.ts`'s own doc comment).
- Fraud/risk detection is a single, bounded first pass (a payment at/above a review threshold is
  flagged via the existing audit log — `src/lib/payments/paymentService.ts`'s
  `payment_flagged_for_review` audit action) — not a full anomaly-detection engine; master-spec item
  156's broader "new account + high payment," "repeated failure," "multi-business correlation" signals
  are not implemented.
- No self-service support-case creation UI exists — only email (`support@pay2pay.com`,
  `SupportAppeals.tsx`) and the existing appeal-submission flow; `SupportCaseService` case creation is
  admin-initiated only.
- No product-analytics provider is wired in (master-spec item 123) — a product decision on which
  provider to use is needed before any implementation, given item 122's constraint on avoiding
  sensitive financial content in analytics events.
