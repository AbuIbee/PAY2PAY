# Sprint Control

Tracks status, dependencies, and sequencing for the 20 sprint files in `docs/sprints/`
(`SPRINT_01_...` through `SPRINT_20_...`). Companion document: `docs/SPRINT_REQUIREMENTS_MATRIX.md`
(per-sprint requirement-ID mapping).

**Revision 2** — repair pass. Resolves the two High-severity findings from Revision 1 (§17 full
identity verification, §26 MFA — both previously "STOPPED — REQUIREMENT/DEPENDENCY CONFLICT
FOUND") plus the Medium-severity §19 pricing gap and the Low-severity §28 retention gap, by editing
Sprints 2, 3, 4, 6, 9, 15, 18, and 20. No application code was implemented; these are sprint-plan
document edits only.

## A. File existence

Unchanged from Revision 1 — all 20 sprint files exist in `docs/sprints/`, filenames match.

## B. Duplicate primary-scope analysis (re-run)

**Still no two sprints claim the same primary deliverable**, including after this repair pass's
additions. Every new cross-sprint reference added in this repair is a *consumer* calling a
*primitive/interface owned by exactly one sprint* — not a second implementation of the same thing:

- Sprint 2 owns the MFA/step-up primitive (`requireStepUp`). Sprints 4, 6, and 15 call it; none of
  them re-implement MFA.
- Sprint 3 owns the identity-verification architecture (state model, `isFullyVerified` interface)
  and the pricing/account-plan architecture. Sprint 6 and Sprint 9 call `isFullyVerified`. **Sprint
  12 was planned to read the pricing model but, per its own "Sprint 12 implementation notes" below,
  actually reads Sprint 5's `feeAllocation` term instead** — Sprint 3's §19 pricing tables are
  business-subscription fees, not a per-payment processor-fee rate source; corrected here to match
  what was actually built (`docs/SPRINT_REQUIREMENTS_MATRIX.md` rows 3/12 carry the same correction).
- Sprint 9 owns the actual KYC/KYB provider integration, kept as a second, explicitly non-merged
  interface alongside its existing (unchanged) payment-provider abstraction. Sprint 3 owns the
  architecture the integration fills in — the split mirrors the existing Sprint 5/Sprint 9 pattern
  (domain logic vs. provider integration) already present in the plan before this repair.
- Sprint 18 owns retention/legal-hold *operations* (placing, releasing, auditing holds). Sprint 20
  *verifies* that behavior as part of its existing role as the terminal readiness gate — the same
  build-then-gate relationship Sprint 20 already has with every other sprint's output (e.g., Sprint
  19's security hardening).

`docs/SPRINT_DUPLICATION_REPORT.md` was **not created** in Revision 1 and remains unnecessary now.

## C. Comparison against the master specification (re-run)

- Every sprint's primary scope still traces cleanly to a master-spec section and requirement ID —
  see `docs/SPRINT_REQUIREMENTS_MATRIX.md` for the full mapping, including the rows changed by this
  repair.
- Money-handling and agreement-state-vocabulary consistency findings from Revision 1 are unchanged
  (still consistent, no conflicts).
- Of the four gaps identified in Revision 1 (§17, §26, §19, §28), **three of the four (§17, §26,
  §19) are resolved by this repair pass, plus §28 (retention), which Revision 1 had scored Low
  severity** — all four now have an owning sprint. See "Resolved in this repair pass" in
  `docs/SPRINT_REQUIREMENTS_MATRIX.md`.
- **One Medium-severity item from Revision 1 remains open and was not part of this repair's
  instruction list:** Sprint 17 (Notifications) is still sequenced after several sprints (5, 6, 8,
  13, 14, 15, 16) that reference "notify" as required functionality. See Sequencing risk 1 below —
  carried forward, reassessed as non-blocking.

## D. Dependency graph and sequencing (re-run)

```
1 (standalone — deploy/marketing)

2 (auth, base profile, MFA primitive) ─▶ 3 (full profiles, verification architecture,
        │                                    pricing architecture)
        │                                        │         │
        │                                        ▼         ▼
        │                                  4 (staff/RBAC)  ...
        │                                        │
        │              ┌─────────────────────────┘
        ▼              ▼
  6 (signatures) ◀── 5 (agreement engine)
        │                    │
        │        ┌───────────┼───────────────┐
        │        ▼            ▼               ▼
        │  7 (evidence/  8 (B2B workflows/
        │   witnesses)     CSV import)
        │
        └── depends on 2 (requireStepUp) + 3 (isFullyVerified) — both precede 6 ✓

3 (verification architecture) ─▶ 9 (payment abstraction + KYC/KYB integration,
                                      enforces isFullyVerified once at payment creation)
                                        │
                                        ▼
                                  10 (ledger) ─▶ 11 (ACH) ─▶ 12 (debit card, reads
                                                │                 5's feeAllocation term —
                                                │                 not 3's pricing model,
                                                │                 corrected during Sprint 12)
                                                ▼
                                          13 (failed payments/retry)

14 (amendments/hardship) ─┐
15 (partial/settlement,   ├─▶ depend on 5's versioning + lifecycle states;
    calls 2's requireStepUp) 15 also depends on 2 (MFA) — precedes it ✓
16 (disputes)             ┘   16 also depends on 11/12 for payment-dispute raw state

17 (notifications) ─── consumed by 5, 6, 8, 13, 14, 15, 16 (Sequencing risk 1, open, non-blocking)

18 (admin/support/appeals, retention/legal holds) ─▶ depends on 16 (dispute review),
                               3/9 (verification review, now resolvable), owns hold operations
19 (fraud/risk/security)   ─▶ depends on nearly everything existing to test against
20 (closed beta readiness, ─▶ terminal gate; now also verifies Sprint 18's retention holds
    retention verification)    end-to-end, including a restore drill covering held records
```

Every dependency edge added or clarified by this repair points **backward** (to a lower-numbered
sprint) or to itself — no new forward reference was introduced. The two High-severity forward
references from Revision 1 (Sprint 6 → nonexistent MFA/verification; Sprints 9–12 → nonexistent
MFA/verification) are now backward references (Sprint 6 → Sprints 2, 3; Sprint 9 → Sprint 3).

### Sequencing risk 1 — Notifications built after seven sprints already reference it (carried forward, reassessed)

Unchanged from Revision 1: Sprint 17 is sequenced 17th; Sprints 5, 6, 8, 13, 14, 15, 16 reference
"notify" before it exists. **Not in this repair's instruction list, so not edited.** Reassessed
severity: **Medium, non-blocking** — unlike the §17/§26 case, a viable implementation exists
without contradiction or rework: earlier sprints write to an internal notification-events
record/table (which requires no infrastructure beyond a database write), and Sprint 17 later wires
real delivery channels (email/SMS/in-app) on top of the existing event records. This does not
require any earlier sprint to be rebuilt when Sprint 17 lands. Recommend documenting this
interpretation explicitly in Sprints 5/6/8/13/14/15/16 in a future pass, but it does not block
execution.

## E. Status

| Sprint | Status |
|---|---|
| 1 | **COMPLETE.** All 13 required-work items and all 8 acceptance criteria in `docs/sprints/SPRINT_01_PublicPreview _VercelReadiness.md` satisfied. Tests: 99/99 passing (18 files). Build: succeeds. Git commit: `82b2d98` ("Complete Sprint 1 public preview and early access") — verified present on `master`, contents match this sprint's file list. Vercel preview/production reference: `https://paid2you.com` — fetched and confirmed live, serving this build (disclaimer copy matches verbatim). ChatGPT/Product Owner review: **PASS**. Full report in `docs/PROGRESS.md`. |
| 2 | **COMPLETE.** All 12 required-functionality items and the MFA/step-up primitive from `docs/sprints/SPRINT_02_Authentication.md` implemented on branch `sprint-02-authentication`. Local `lint`/`typecheck`/`test`/`build` all pass (165/165 tests). GitHub CI: **success** (run [31323009535](https://github.com/AbuIbee/PAY2PAY/actions/runs/31323009535)). Vercel preview: **success** (build completed; content not independently browsed — protected by Vercel SSO). ChatGPT/Product Owner review: **PASS** — architecture condition satisfied by `docs/AUTH_ARCHITECTURE_DECISION.md` (Supabase Auth adoptability, migration path, and risk analysis for the retained-custom-auth decision). **Not merged into `master`. Not deployed to production**, per governance — this sprint's branch is not auto-merged even on a PASS review. |
| 3 | **COMPLETE.** All required items from `docs/sprints/SPRINT_03_Personal_Business_Profiles.md` implemented on branch `sprint-03-profiles` (branched from `sprint-02-authentication`'s merged tip). Local `lint`/`typecheck`/`test`/`build` all pass (221/221 tests). GitHub CI: **success** (run [31326343117](https://github.com/AbuIbee/PAY2PAY/actions/runs/31326343117)). Vercel preview: **success** (build completed; content not independently browsed — protected by Vercel SSO, same as Sprint 2). **Not merged into `master`. Not deployed to production** (confirmed: `master` HEAD unchanged at `026b371`, PR #2 open/unmerged, and `https://paid2you.com` re-fetched — shows Sprint 2's "Sign in" link but no "Dashboard" mention, i.e. still exactly the Sprint 2 merged state). ChatGPT/Product Owner review: **PASS**. |
| 4 | **COMPLETE — awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_04_BusinessStaff_Permissions.md` (capability model, staff invitation/acceptance/removal, custom roles, settlement/balance-adjustment approval limits, two-person/owner-required approval configuration, step-up hooks on every high-risk change, RLS on all three new tables) implemented on branch `sprint-04-business-permissions` (branched from `sprint-03-profiles`'s merged tip). Local `lint`/`typecheck`/`test`/`build` all pass (243/243 tests). GitHub CI: **success** (run [31328386726](https://github.com/AbuIbee/PAY2PAY/actions/runs/31328386726)). Vercel preview: **success** (build completed; content not independently browsed — protected by Vercel SSO, same as Sprints 2–3). **Not merged into `master`. Not deployed to production** (confirmed: `master` HEAD unchanged at `4a62d6d`, the Sprint 3 merge commit; PR #3 open/unmerged). ChatGPT/Product Owner review: **pending**. |
| 5 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_05_Agreement_Engine.md` (P2P/B2C/C2B/B2B agreements, either-party draft initiation, debtor acknowledgment, all 20 required terms fields, integer-minor-unit schedule calculation with deterministic rounding, the full 14-state lifecycle with invalid-transition guards, signed-version immutability, audit events on every transition, creditor accept/reject/counter, and a functional UI) implemented on branch `sprint-05-agreement-engine`. A first pass was audited and found incomplete (missing the creditor-decide and sign API routes, no UI, a dead-code duplication in `validation.ts`); a second pass closed all three gaps — see "Sprint 5 gap-closure record" below. Local `lint`/`typecheck`/`test`/`build` all pass (269/269 tests, up from 243 at the end of Sprint 4). `drizzle-kit check` confirms the new migration (`0005_slim_shadow_king.sql`) is internally consistent. **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — per this session's explicit instruction, commit/push is deferred until Product Owner review of this status entry. No payment integration (explicitly out of scope for this sprint) and no prior sprint's behavior was altered. |
| 6 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md` (full electronic-signature evidence capture, step-up + full-verification + business-signing-authority gates before any signature, immutable per-version PDF generation, Supabase Storage private-bucket abstraction with signed-URL access, tamper-evident hashing, and all 11 required test categories) implemented on branch `sprint-06-ElectronicSignatures_PDFRecords`, branched from `master`'s tip (`55ae530`, the Sprint 5 merge commit — confirmed via `git merge-base --is-ancestor`). Local `lint`/`typecheck`/`test`/`build` all pass (282/282 tests, up from 269 at the end of Sprint 5). `drizzle-kit check` confirms the new migration (`0006_last_otto_octavius.sql`) is internally consistent. Sprint 5's own 26 tests all still pass unchanged, confirming no Sprint 5 behavior was altered beyond the two explicitly-required, purely-additive touches (a shared `computeVersionHash` extraction with identical output, and a new public `resolvePartyRole` wrapper). **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — deferred until Product Owner review of this status entry, per this session's explicit instruction. No payment integration (explicitly out of scope) was added. See "Sprint 6 implementation notes" below for what was and wasn't built, and why. |
| 6A | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_06A_Platform_Administration_Audit_Control.md` (three-tier platform-role model, protected `/admin` control plane with server-side-only authorization, functional dashboard/user-search/user-detail UI backed entirely by real data, suspend/reactivate/revoke-sessions/role-change/classification admin operations, durable test-account classification, full audit logging of every admin action, read-only "View As User" support view, documented break-glass recovery with no in-app bypass, and all 10 required test categories) implemented on branch `sprint-06A-platform-administration`, branched from `master`'s tip (`72ae5b4`, the Sprint 6 merge commit). Local `lint`/`typecheck`/`test`/`build` all pass (303/303 tests, up from 282 at the end of Sprint 6). `drizzle-kit check` confirms the new migration (`0007_short_gauntlet.sql`) is internally consistent. Sprints 1–6's own tests all still pass unchanged, confirming no regression despite three necessary, narrowly-scoped touches to Sprint 2's auth layer (see "Sprint 6A implementation notes" below). **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — deferred until Product Owner review of this status entry, per this session's explicit instruction. No agreement/signature/PDF table was ever imported by any Sprint 6A code — see the implementation notes for how that guarantee is structural, not just tested. |
| 7 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_07_Evidence_Documents_Witnesses.md` (evidence upload/metadata/uploader/timestamp/agreement-association, shared/private classification, witness-sharing, dispute flag, withdrawal state, malware/file-validation abstraction, secure signed-URL access, mandatory post-signing labeling, and the full witness model — max two, verified, view-only, version-bound attestation) implemented on branch `sprint-07-evidence-documents-witnesses`. **This branch was stale when this session started** — it had been created before Sprint 6A was merged and had zero unique commits of its own, so it was fast-forwarded to `master`'s current tip (`4356d24`, the Sprint 6A merge commit) before any Sprint 7 work began; confirmed safe via `git merge-base --is-ancestor` (no divergence, no data loss, branch not yet pushed to origin). Local `lint`/`typecheck`/`test`/`build` all pass (326/326 tests, up from 303 at the end of Sprint 6A). `drizzle-kit check` confirms the new migration (`0008_steep_mysterio.sql`) is internally consistent; RLS + `REVOKE` confirmed present on both new tables. Sprints 1–6A's own tests all still pass unchanged. **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — deferred until Product Owner review of this status entry. No payment-processing functionality was added (not required by this sprint). See "Sprint 7 implementation notes" below for design choices and scope boundaries. |
| 8 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_08_Workflows_CSVImports.md` (B2B workflow completion requiring both parties to be verified business profiles, invoice/PO/contract reference tracking, a real-data business financial dashboard, and the full CSV import pipeline — UPLOAD/VALIDATE/PREVIEW/DUPLICATE CHECK/ERROR REPORT/CREATE DRAFTS — with no bulk activation) implemented on branch `sprint-08-workflows-csv-imports`, branched from `master`'s tip (`261ec0e`, the Sprint 7 merge commit; this branch was already up to date, no fast-forward needed this time). Local `lint`/`typecheck`/`test`/`build` all pass (343/343 tests, up from 326 at the end of Sprint 7). `drizzle-kit check` confirms the new migration (`0009_flat_barracuda.sql`) is internally consistent; RLS + `REVOKE` confirmed present on all three new tables. Sprints 1–7's own tests all still pass unchanged, including Sprint 3's `/api/dashboard/business` route test, which was deliberately never touched. **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — deferred until Product Owner review of this status entry. See "Sprint 8 implementation notes" below for design choices and scope boundaries. |
| 9 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_09_PaymentProviderAbstraction _Sandbox.md` (provider-independent payment abstraction with sandbox adapter, the shared `isFullyVerified` payer-and-recipient gate enforced once in `PaymentService.createPayment`, outbound idempotency-key dedupe, inbound webhook signature verification/replay protection/idempotent processing, and the separate KYC/KYB provider abstraction wired to Sprint 3's `FULL_PENDING → FULL_VERIFIED/FULL_REJECTED` transition) implemented on branch `sprint-09-payment-provider-abstraction`, branched from `master`'s tip (`b5f68ed`, the Sprint 8 merge commit; already up to date, no fast-forward needed). Local `lint`/`typecheck`/`test`/`build` all pass (394/394 tests, up from 343 at the end of Sprint 8). `drizzle-kit check` confirms the new migration (`0010_great_human_fly.sql`) is internally consistent; RLS + `REVOKE` confirmed present on all three new tables (`payment_attempt`, `payment_webhook_event`, `kyc_webhook_event`). Sprints 1–8's own tests all still pass unchanged, including Sprint 3's `isFullyVerified`/`getVerificationState`/`submitFullVerificationRequest`/`recordManualVerificationDecision` bodies, which are byte-identical to before this sprint. **No production/live payment or KYC provider was integrated or called — sandbox/mock only, per "NO PRODUCTION MONEY."** **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — deferred until Product Owner review of this status entry. See "Sprint 9 implementation notes" below for design choices, provider recommendations, and scope boundaries. |
| 10 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_10_InternalFinancialLedger.md` (double-entry-style shadow ledger with a five-account chart matching `docs/PAYMENT_ARCHITECTURE.md` §14, balanced/immutable/append-only journal entries idempotent per `(payment_attempt_id, entry_type)`, reconciliation against provider records covering all 10 required exception types, deterministic balance reconstruction from ledger history alone, and Platform Admin/Owner-gated administrative visibility with a reason-required, append-only correction path) implemented on branch `sprint-10-ledger-reconciliation`, branched from `master`'s tip (`d64bcae`, the Sprint 9 merge commit; already up to date, no fast-forward needed). Local `lint`/`typecheck`/`test`/`build` all pass (447/447 tests, up from 394 at the end of Sprint 9). `drizzle-kit check` confirms the new migration (`0011_slippery_payback.sql`) is internally consistent; RLS + `REVOKE` confirmed present on all four new tables (`ledger_account`, `ledger_journal_entry`, `ledger_posting`, `reconciliation_exception`). Sprints 1–9's own tests all still pass unchanged, including every Sprint 9 payment/webhook test — the ledger wiring added to `PaymentWebhookService` is additive and fails soft (logs, never throws) when a payment has no `agreementId`, matching Sprint 9's own test fixtures that never set one. **No production/live money movement — this sprint posts to an internal shadow ledger only, never a real processor, per "Do not enable production transactions."** **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — deferred until Product Owner review of this status entry. See "Sprint 10 implementation notes" below for design choices, scope boundaries, and known limitations. |
| 11 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_11_ACH_Sandbox.md` (borrower mandate/authorization with revocation and a bank-change hook, first/recurring/manual ACH payment scheduling and submission, the granular Scheduled→Submitted→Processing lifecycle cross-checked against `docs/PAYMENT_STATE_MACHINE.md` §1, duplicate-debit prevention, and "payout only after Cleared" reusing Sprint 10's existing guard) implemented on branch `sprint-11-ach-sandbox`, branched from `master`'s tip (`c902790`, the Sprint 10 merge commit). Local `lint`/`typecheck`/`test`/`build` all pass (473/473 tests, up from 447 at the end of Sprint 10). `drizzle-kit check` confirms the new migration (`0012_crazy_kylun.sql`) is internally consistent — purely additive (one new enum, four `ALTER TYPE ADD VALUE`s, one new table, two new nullable columns); RLS + `REVOKE` confirmed present on the one new table (`ach_mandate`). Sprints 1–10's own tests all still pass unchanged. **No production/live money movement — sandbox only, per "Implement ACH payment behavior in sandbox/test mode."** **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — deferred until Product Owner review of this status entry. See "Sprint 11 implementation notes" below, including a correction to Sprint 10's `reversed`/`returned` status naming. |
| 12 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_12_DebitCard_Sandbox.md` (tokenized debit card on file, initial/recurring payment, decline, expired card, replaced card, dispute (chargeback), refund, and the ACH-vs-card fee-reallocation rule) implemented on the current session's worktree branch, sequenced after Sprint 11 (ACH) per `docs/SPRINT_CONTROL.md`'s own dependency graph. Local `lint` (0 errors), `typecheck` (0 errors), `test` (504/504, up from 473 at the end of Sprint 11 — see note below), and `build` (`next build`, Turbopack) all pass. `drizzle-kit check` confirms the new migration (`0013_busy_anthem.sql`) is internally consistent; RLS + `REVOKE` confirmed present on the one new table (`debit_card_method`), matching every prior migration's pattern (the `REVOKE` line is not auto-generated by `drizzle-kit generate` — it was added by hand to this migration file, same as every migration before it). Migration is purely additive: 2 new enums (`payment_method`, `debit_card_method_status`), 1 new table, 1 new nullable column (`payment_attempt.payment_method`). Sprints 1–11's own tests all still pass unchanged. **No live processor integration — sandbox only, per this sprint's "Implement debit-card payments in sandbox/test mode" and open decision #3 (unchanged since Sprint 9).** **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — deferred until Product Owner review of this status entry, per this session's explicit instruction. See "Sprint 12 implementation notes" below for design choices, scope boundaries, and known limitations.
  - Test-count note: 473 was Sprint 11's own final count. Between Sprint 11 and Sprint 12, a separate, unrelated change in this same session (a `POSTGRES_URL` fallback for `DATABASE_URL` in `src/config/env.ts`, for Vercel's native Postgres integration) added 2 tests, bringing the pre-Sprint-12 baseline to 475. This sprint added 29 (`cardFeeAllocation.test.ts`: 6, `debitCardMethodService.test.ts`: 10, `debitCardPaymentService.test.ts`: 13), for a total of 504. |
| 13 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md` (mark failure, notify both parties, non-sensitive failure category, borrower manual payment, single configurable-delay retry defaulting to ~3 business days, manual success cancels the retry, retry failure stops further automatic attempts, borrower-requested reschedule requiring creditor approval, no automatic late fees, original installment record preserved, and a Vercel-compatible background-job/scheduler abstraction) implemented in a fresh worktree branched from `origin/master`'s tip (`1785466`, the Sprint 12 merge commit). Local `lint` (0 errors), `typecheck` (0 errors), `test` (524/524, up from 504 at the end of Sprint 12 — 20 net new), and `build` (`next build`, Turbopack) all pass, all after a required `npm ci` in this worktree (its own `node_modules` was otherwise nearly empty — a worktree-isolation artifact, not a code issue, same as Sprint 12's own note). `drizzle-kit check` confirms the new migration (`0014_chubby_argent.sql`) is internally consistent; RLS + `REVOKE` confirmed present on all three new tables (`notification_event`, `payment_retry`, `reschedule_request`) — the `REVOKE` lines were added by hand, matching every prior migration's pattern. Migration is purely additive: 2 new enums, 3 new tables, zero altered/dropped columns. Sprints 1–12's own tests all still pass unchanged. **No real background-job infrastructure exists — the "scheduler" is `POST /api/scheduler/retry-failed-payments`, intended to be called by a Vercel Cron Job (`vercel.json`), matching this sprint's own "compatible with Vercel architecture" instruction rather than standing up a queue this platform has no persistent process to run.** **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — deferred until Product Owner review of this status entry, per this session's explicit instruction. See "Sprint 13 implementation notes" below for design choices, two real pre-existing bugs this sprint's own tests caught and fixed, scope boundaries, and known limitations. |
| 14 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_14_Amendments_Hardship.md` (borrower may request new date / temporary pause / reduced installment / revised schedule; creditor accept/reject/counter; existing agreement remains controlling until both parties sign; no interest, no penalty growth; every accepted change creates a new immutable version; full amendment audit trail) implemented in a fresh worktree branched from `origin/master`'s tip (`fed954c`, the Sprint 13 merge commit). Local `lint` (0 errors), `typecheck` (0 errors), `test` (538/538, up from 524 at the end of Sprint 13 — 14 net new), and `build` (`next build`, Turbopack) all pass, all after a required `npm ci` in this worktree (its own `node_modules` was otherwise nearly empty — a worktree-isolation artifact, not a code issue, same as Sprints 12–13's own notes). `drizzle-kit check` confirms the new migration (`0015_damp_young_avengers.sql`) is internally consistent; RLS + `REVOKE` confirmed present on the one new table (`amendment`) — the `REVOKE` line was added by hand, matching every prior migration's pattern. Migration is purely additive: 2 new enums, 1 new table, zero altered/dropped columns. Sprints 1–13's own tests all still pass unchanged. **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — deferred until Product Owner review of this status entry, per this session's explicit instruction. See "Sprint 14 implementation notes" below for the single-table amendment model scope decision, and "Sprint 14 Product Owner review pass" for two real gaps the review found and fixed (authorization capability gate; signature-evidence audit context) plus what deliberately remains a documented, unfixed scope boundary (Sprint 6's full evidence bundle). |
| 15 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_15_ PartialPayments_Settlement.md` (borrower-proposed partial payment with creditor accept/reject/counter, acceptance never automatically forgiving the remainder; settlement recording pre-settlement balance/settlement amount/forgiven amount/deadline/one-time-vs-scheduled/failed-settlement consequence with all four explicit failure-consequence options; successful settlement marked `SETTLED_IN_FULL`, never `PAID_IN_FULL`; creditor's finalizing acceptance of a settlement gated by Sprint 2's `requireStepUp(user, "approve_settlement")`) implemented in a fresh worktree branched from `origin/master`'s tip (`9f8dc9e`, the Sprint 14 merge commit). Local `lint` (0 errors), `typecheck` (0 errors via `npm run typecheck`, this project's own authoritative gate — see "Sprint 15 Product Owner review pass" below for why a bare `tsc --noEmit` run before any build/dev pass in a fresh worktree reports one false-positive `LayoutProps` error that disappears once `.next/types` exists), `test` (576/576, up from 538 at the end of Sprint 14 — 38 net new), and `build` (`next build`, Turbopack) all pass, after a required `npm ci` in this worktree (its own `node_modules` was otherwise nearly empty — a worktree-isolation artifact, not a code issue, same as every prior worktree sprint's own note). `drizzle-kit check` confirms the new migration (`0016_blushing_adam_destine.sql`) is internally consistent; RLS + `REVOKE` confirmed present on all three new tables (`partial_payment_request`, `settlement_proposal`, `settlement_payment`) — the `REVOKE` lines were added by hand, matching every prior migration's pattern. Migration is purely additive: 4 new enums, 3 new tables, zero altered/dropped columns (`agreement_status`'s `settled_in_full`/`paid_in_full` values already existed from Sprint 5). Sprints 1–14's own tests all still pass unchanged. **No live processor integration — settlement/partial payments are recorded against already-succeeded `payment_attempt` rows collected through the existing Sprint 9–13 payment gate, never a separate money-movement path.** **Not yet committed, not pushed, no PR opened, no CI run, no Vercel preview** — deferred until Product Owner review of this status entry, per this session's explicit instruction. See "Sprint 15 implementation notes" below for the negotiation-collapsing scope decision and the failure-consequence resolution design, and "Sprint 15 Product Owner review pass" for a real settlement step-up/capability authorization gap this review pass found and fixed. |
| 16 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_16_Disputes.md` (two distinct dispute systems, never conflated: agreement-level disputes with explanation/category/evidence/response/status/audit trail, and payment-level unauthorized-payment claims preserving mandate/signatures/identity-verification reference/IP/device/timestamp; "the platform must not adjudicate legal liability"; "the processor handles payment dispute outcome"; evidence-package export) implemented in a fresh worktree branched from `origin/master`'s tip (`a4f6507`, the Sprint 15 merge commit). Local `lint` (0 errors), `typecheck` (0 errors via `npm run typecheck`), `test` (599/599, up from 576 at the end of Sprint 15 — 23 net new), and `build` (`next build`, Turbopack) all pass, after a required `npm ci` in this worktree. `drizzle-kit check` confirms the new migration (`0017_careless_captain_marvel.sql`) is internally consistent; RLS + `REVOKE` confirmed present on both new tables (`agreement_dispute`, `payment_dispute`) — the `REVOKE` lines were added by hand, matching every prior migration's pattern. Migration is purely additive: 4 new enums, 2 new tables, zero altered/dropped columns. Sprints 1–15's own tests all still pass unchanged. **No live processor integration — a payment dispute's actual resolution reuses the exact same `LedgerService`/`payment_attempt` status mechanics the Sprint 9/10 `payment.disputed`/`payment.refunded` webhooks already use.** **Reviewed: both documented limitations (denied-claim ledger correction; restriction not enforced by payment scheduling) independently re-examined against the authoritative spec and confirmed correctly out of scope — see "Sprint 16 Product Owner review pass" below; no code changes were required.** See "Sprint 16 implementation notes" below for how heavily this sprint reused Sprint 7 (evidence dispute-flag), Sprint 9/10 (webhook-driven disputed/refunded status + ledger `dispute_adjustment`/`refund` entries + `BalanceService`'s existing reversal handling), Sprint 11/12 (mandate/card-on-file preservation), and Sprint 14 (amendment hand-off) rather than building new mechanics. |
| 17 | **COMPLETE — uncommitted, awaiting Product Owner review.** All required-functionality items from `docs/sprints/SPRINT_17_Notifications.md` (email/SMS/in-app channel abstraction; all 18 named events; notification table, templates, delivery status, retry strategy, preference model, failure logging; critical notifications cannot be disabled; no unrestricted chat) implemented in a fresh worktree branched from `origin/master`'s tip (`02fb5cf`, the Sprint 16 merge commit). Local `lint` (0 errors), `typecheck` (0 errors via `npm run typecheck`), `test` (611/611, up from 599 at the end of Sprint 16 — 12 net new after the review pass below), and `build` (`next build`, Turbopack) all pass, after a required `npm ci` in this worktree. `drizzle-kit check` confirms the new migration (`0018_flawless_morlocks.sql`) is internally consistent; RLS + `REVOKE` confirmed present on the one new table (`notification_preference`) — `notification_event`'s own `REVOKE` already exists from its original Sprint 13 migration and needs no re-statement for its 7 new columns. Migration is purely additive: 2 new enums, 1 new table, 7 new nullable/defaulted columns on the existing `notification_event`, zero dropped columns. Sprints 1–16's own tests all still pass unchanged, including `paymentRetryService.test.ts`'s pre-existing email-content assertions, verified to still pass against the rewritten template-driven delivery path. **No live provider integration — email/SMS still go through Sprint 2's `ConsoleEmailSender`/`ConsoleSmsSender` (log-only), matching every prior sprint's identical "no production transport" precedent.** **Reviewed: two real gaps found and fixed (settlement reclassified critical; `payment_cleared`/`payment_disputed` wired to a real trigger for the first time) — see "Sprint 17 Product Owner review pass" below, including the one gap found but deliberately not fully closed in this pass (15 of 18 event types still have no real trigger anywhere in the codebase).** See "Sprint 17 implementation notes" below for the one behavioral change to Sprint 13's own `NotificationService.notify` signature (subject/body replaced by template-driven rendering) and the Vercel Hobby-plan cron-frequency limitation this sprint's retry cadence inherits from Sprint 13's own precedent. |
| 18–20 | Not started. Sprint plan documents for 18, 20 were revised in the earlier repair pass; no application code has been implemented for any of them. |

### Sprint 17 implementation notes

**`NotificationService.notify`'s signature changed — the one deliberate behavioral change to a prior sprint's (Sprint 13's) own file, and exactly the hand-off that sprint's own doc comment anticipated.** The old signature took caller-supplied `subject`/`body` strings; every notification is now rendered from `NOTIFICATION_TEMPLATES` (`src/lib/notify/templates.ts`) keyed by a closed `NotificationEventType` union (`src/lib/notify/eventTypes.ts`), matching this sprint's own "Implement: templates" requirement. The sole existing caller, `FailedPaymentWorkflowService` (Sprint 13), was updated to pass `payload: { failureCategory }` instead of pre-rendered text — the `payment_failed` template's own subject/body strings are byte-identical to what `FailedPaymentWorkflowService.failureBody` used to build inline, so `paymentRetryService.test.ts`'s pre-existing `emailSender.sent` assertions needed no changes and still pass unmodified. "No unrestricted chat" (this sprint's own instruction, verbatim) is enforced by construction from this same change: there is no method anywhere in `NotificationService` that accepts caller-supplied free-text subject/body for delivery — only a fixed, closed set of event types can ever be rendered and sent.

**One `notify()` call fans out into one `notification_event` row per applicable channel**, not one row with a channel-list column — `eventTypes.ts`'s `DEFAULT_CHANNELS` table gives each of the 18 event types its own default channel set (every critical type includes `sms`; non-critical types default to `email` + `in_app` only), filtered per-channel by the recipient's own preference unless the type is critical. This keeps "delivery status" and "retry strategy" independently accurate per channel (an email can fail while SMS succeeds) without a second table, and lets the pre-existing in-app case (Sprint 13's own `notification_event` row, queryable via `listForUser`) need no separate delivery step at all — a `channel = 'in_app'` row's own existence *is* the in-app notification, so it goes straight from `pending` to `delivered` on insert.

**Critical/channel classification is a documented interpretive judgment call, not something master spec or this sprint's instruction text enumerates.** The nine types classified critical (`payment_failed`, `payment_disputed`, `bank_change`, `card_change`, `authorization_revoked`, `security_event`, `staff_permissions`, `payout_account_change`, `account_restriction`) are every event whose absence could cause real financial or security harm if silently missed; the remaining nine (contract-lifecycle/negotiation events) are not. "Critical notifications cannot be disabled" is structural, not a runtime check that could be bypassed: `resolveChannels` never calls `preferences.find` at all for a critical type, and `setPreference` silently no-ops an attempted opt-out of one — there is no code path capable of suppressing a critical notification, however a preference row for one might have been created.

**Delivery dedup reuses `payment_attempt.idempotency_key`'s identical Sprint 9 precedent.** A caller-supplied `dedupeKey` (e.g. `payment_failed:{paymentAttemptId}:{recipientUserId}`, what `FailedPaymentWorkflowService` now passes) is combined with the channel to form each row's own unique key (`notification_event.dedupe_key`, unique index, NULLs distinct so most rows — those from callers that don't supply one — are unaffected); a second `notify()` call with the same key returns the existing rows instead of sending again. This is what makes a webhook or workflow retry safe to call `notify()` again for the same logical event.

**Retry strategy mutates the same `notification_event` row in place, deliberately diverging from `payment_retry`'s "new row per attempt" model (Sprint 13).** A failed notification delivery increments `attempt_count` and sets `next_retry_at` on its own row rather than creating a new one — unlike a payment attempt, a notification-delivery attempt carries no money-movement "preserve the original record" requirement, so the simpler in-place model is appropriate. `POST /api/scheduler/retry-notifications` (Sprint 13's established cron-route pattern: `CRON_SECRET` Bearer auth, `timingSafeStringEqual`, no `requireSession`) is a new `vercel.json` entry. **Known limitation, inherited from Sprint 13's own identical precedent**: the in-code default retry delay (15 minutes, configurable via `NotificationServiceOptions`) does not match the *actual* firing cadence in this environment — Vercel Hobby-plan cron jobs are limited to once daily, the same constraint Sprint 13's own `docs/SPRINT_CONTROL.md` note already documented for payment retries. A failed notification may not actually redeliver for up to 24 hours in this deployment tier; not fixed here for the same reason Sprint 13 didn't fix it (a Pro-plan deployment can run the same route more often with no code change).

**Failure logging**: every failed delivery attempt records `failure_reason` directly on its own `notification_event` row (queryable per-user via `listForUser`, per-admin via the existing ledger/reconciliation-style visibility this sprint didn't need to duplicate) — no separate failure-log table, matching Sprint 9–13's own established "log via the row's own status/reason fields, not a parallel audit table" precedent for payment-adjacent failures.

**No UI was built** (this sprint's file has no "UI" bullet, matching every prior worktree sprint's precedent). Three new routes, all `requireSession` + zod + `withErrorHandling` (except the cron route): `GET /api/notifications` (the caller's own notifications only — `recipientUserId` is always the session's own user id, never accepted as a request parameter, the concrete mechanism behind this sprint's "authorization" required test), `GET`/`POST /api/notifications/preferences`, `POST /api/scheduler/retry-notifications`.

### Sprint 16 implementation notes

**This sprint is, by design, mostly composition of existing infrastructure rather than new mechanics — several prior sprints' own doc comments explicitly anticipated it.** `ach_mandate`'s own Sprint 11 comment says its append-only design exists "preserving the authorization history an unauthorized-payment claim would need" (FR-UPAY-003); `payment.ts`'s Sprint 11 comment reserves `installmentScheduleItemId: null` for "any future extra/settlement payment (Sprint 15+)" and, by the same logic, this sprint's claims; `BalanceService.reconstruct`'s `wasReversed` check already includes `"dispute_adjustment"` in its reversal-entry-type list — added in Sprint 10, unused by any sprint until now. None of these needed to change for Sprint 16; they only needed to be exercised.

**Payment dispute: `claimUnauthorizedPayment` reuses the exact same `LedgerService.reversePayment`/`PaymentAttemptRepository.updateStatus` calls the `payment.disputed` webhook (Sprint 9/10, `PaymentWebhookService`) already makes** — a claim filed through this sprint's own UI and a dispute the processor reports asynchronously produce byte-identical ledger/status effects, never two competing transition paths. `recordProcessorOutcome`'s `"upheld"` path reuses the same `"refund"` entry type the `payment.refunded` webhook posts, for the same reason. `"denied"` reinstates `payment_attempt.status` to `"succeeded"` but does **not** attempt to un-post the earlier `dispute_adjustment` ledger entry — `LedgerJournalEntryRepository` is append-only by design (Sprint 10) with no "un-reverse" entry type, and this sprint does not add one. **Documented known limitation**: until a platform admin posts a correcting entry via Sprint 10's own existing `LedgerAdminService.postAdjustment` escape hatch, `BalanceService`'s presence-based `wasReversed` check continues to exclude a "denied" payment from the agreement's paid balance even though the payment stands. Not fixed here because doing so would mean changing Sprint 10's own `wasReversed` semantics from presence-based to "net effect" — a deeper change to a prior sprint's file, out of this sprint's scope, and "denied" is expected to be the rare outcome (the common, fully-tested path — a claim that stays `"claimed"` or is `"upheld"` — has no such gap; see "Tests: reversal impact, balance update").

**Payment dispute preservation fields are opaque snapshot strings, not foreign keys** — `preserved_mandate_reference`/`preserved_signature_reference`/`preserved_identity_verification_reference` capture an `ach_mandate`/`debit_card_method`/`signature_event`/`identity_verification_record` id at claim time via three new narrow reader interfaces (`MandateReferenceReader`/`SignatureReferenceReader`/`IdentityVerificationReferenceReader`), never a DB foreign key — the referenced row may later be revoked/replaced/superseded (all three source tables are themselves append-only, per their own Sprint 11/6/3 doc comments), and the claim's snapshot must remain exactly what it was at claim time regardless of what happens to the live row afterward.

**Agreement dispute: evidence is never duplicated onto a new table.** `evidence_document.dispute_flag` (Sprint 7) already exists for exactly this; `AgreementDisputeService.openDispute`/`respondToDispute` accept evidence ids and flag them via the pre-existing `EvidenceService.setDisputeFlag`, and `exportEvidencePackage` (this sprint's "support evidence-package export") simply returns the dispute record plus `EvidenceService.listEvidence(...).filter(e => e.disputeFlag)` — "this dispute's evidence" is always just "this agreement's evidence documents currently flagged," never a second store that could drift from the first.

**Agreement dispute: `resolveWithAmendment` hands off to Sprint 14's `AmendmentService` rather than re-implementing any negotiation/signature machinery.** `docs/STATE_MACHINES.md` §7's `ResolvedWithAmendment` and `AmendmentInProgress` are collapsed into one status (`resolved_with_amendment`) — there is no separate action between "resolution requires a signed amendment" and "hands off to the Amendment lifecycle," matching Sprint 14/15's own identical collapsing precedent for adjacent illustrative sub-states with no distinct action of their own. A separate read-time method, `syncAmendmentProgress`, checks whether the linked amendment has reached `Applied` and closes the dispute if so — deliberately not a callback from `AmendmentService` into this sprint's code (no new coupling added to a prior sprint's file).

**"The platform must not adjudicate legal liability" (both systems, this sprint's own instruction, verbatim) is enforced by construction, not just by convention.** Neither `agreement_dispute` nor `payment_dispute` has any "which party was at fault" or "who was legally correct" column anywhere in either schema — `resolveNoChange`'s `resolutionNotes` and `restrictDispute`'s `reason` are free-text records of what happened, matching `docs/STATE_MACHINES.md` §7's own "never sets a terminal state that declares a party legally correct" (FR-DISP-004). `recordProcessorOutcome` is Platform-Admin-only and only ever *records* the processor's own determination, never the platform's own adjudication.

**Known, explicitly documented scope boundary: "scheduled payments continue unless... processor/admin restriction applies" is not enforced by any payment-scheduling code yet.** `AgreementDisputeService.restrictDispute` records the restriction on `agreement_dispute.status`, but no payment service (`PaymentService`/`AchPaymentService`/`DebitCardPaymentService`/`PaymentRetryService`) currently checks it before scheduling or submitting a payment — wiring that check would touch several prior sprints' files for a behavior this sprint's own required-test list doesn't name (only "agreement dispute, payment dispute, permissions, evidence, reversal impact, balance update" are required). Flagged here as a real, load-bearing gap for a future sprint to close, not silently assumed complete — `docs/STATE_MACHINES.md` §7's own note that "scheduled payments are not blocked by Opened/UnderReview status alone" is satisfied (nothing blocks them), but the flip side ("Restricted does block them") is not yet wired.

**No UI was built** (this sprint's file has no "UI" bullet, matching every prior worktree sprint's precedent). Eleven new routes, all `requireSession` + zod + `withErrorHandling`: `POST /api/agreements/disputes/{open,respond,resolve-no-change,resolve-with-amendment,close,sync-amendment-progress,restrict,lift-restriction}`, `GET /api/agreements/disputes/export`, `POST /api/payments/disputes/{claim,record-outcome}`. `restrict`/`lift-restriction`/`record-outcome` additionally require Platform Admin/Owner (`isAdminRole`), reusing Sprint 6A's existing role-check helper rather than a new one.

### Sprint 17 Product Owner review pass — two real gaps found and fixed, one significant gap found and honestly scoped, no blocking issues

Independent re-review against `docs/sprints/SPRINT_17_Notifications.md` (read in full again for this pass), `CLAUDE.md`, and this document, specifically re-examining three flagged questions rather than accepting the implementation pass's own documentation at face value:

1. **Retry strategy vs. the Vercel Hobby cron limit: confirmed acceptable, no fix.** The retry strategy itself — `attempt_count`/`next_retry_at`, exponential-shaped backoff via a configurable delay, exhaustion after `maxAttempts`, cron-triggered redelivery — is complete and fully tested independent of deployment tier. The mismatch between the in-code default (15 minutes) and the actual firing cadence (Vercel Hobby-plan cron: once daily) is the identical, already-reviewed-and-accepted Sprint 13 precedent (`docs/SPRINT_CONTROL.md`'s own Sprint 13 note), not a Sprint 17 defect — this sprint's instruction text states no delivery-timing SLA, and a Pro-plan deployment can run the same route more often with zero code change. Not fixed, for the same reason Sprint 13 wasn't.
2. **Critical/non-critical classification: one real gap found and fixed.** Cross-checking the original nine-type classification against master spec §26's own MFA-required sensitive-action list surfaced that `settlement` — whose whole purpose is forgiving part of a balance — was classified non-critical, even though §26 explicitly names both "Approving settlements" and "Forgiving debt" among its MFA-gated actions. Missing a settlement notification is exactly the "real financial harm if silently missed" bar every other critical type is already held to. Fixed: `settlement` added to `CRITICAL_NOTIFICATION_TYPES` and given the `sms` channel every other critical type gets. `amendment`/`hardship`/`partial_payment` were deliberately left non-critical after the same cross-check — each still requires the recipient to actively accept/counter/sign within its own Sprint 14/15 workflow before taking effect, so missing the *notification* specifically (as opposed to missing the underlying action) doesn't let anything happen unnoticed the way missing a settlement or bank-account-change alert would. New test added (`notificationService.test.ts`'s "settlement is critical" case).
3. **Template-driven rendering preserving prior-sprint behavior: confirmed, verified directly against the diff, not just re-asserted.** `git show`'d the pre-review-pass version of `failedPaymentWorkflowService.ts` and compared it character-for-character against the new `payment_failed` template: subject `"A payment did not go through"` and body `` `A scheduled payment could not be completed (${category}). ...` `` (with the identical `"an issue with the payment method"` fallback) are byte-identical in both. Re-confirmed a repo-wide search finds only two sites that ever construct `NotificationService` directly (`getNotificationService.ts`, `testFakes.ts`) and exactly one production caller of `notify()` (`FailedPaymentWorkflowService`) — so no other prior-sprint integration exists that could have been silently broken by the signature change. `paymentRetryService.test.ts`'s own pre-existing `emailSender.sent` content assertions were re-run and still pass unmodified.
4. **A fourth, more significant gap was found by the same cross-checking discipline, not asked about directly but squarely within "does this violate a Sprint 17 acceptance criterion": of the 18 named events, only `payment_failed` (Sprint 13's own pre-existing integration) had any real trigger anywhere in the codebase before this review pass.** `agreement_invitation`, `agreement_signed`, `amendment`, `payment_scheduled`, `payment_processing`, `payment_cleared`, `payment_disputed`, `bank_change`, `card_change`, `authorization_revoked`, `hardship`, `partial_payment`, `settlement`, `security_event`, `staff_permissions`, `payout_account_change`, and `account_restriction` all had templates and channel/critical classifications ready, but no domain service (`AgreementService`, `AmendmentService`, `SettlementService`, `PartialPaymentService`, either dispute service, `AchMandateService`, `DebitCardMethodService`, `StaffService`, `AdminService`) ever called `notify()` for them — verified by a repo-wide grep for `NotificationService`/`notify(` returning only the notify module and `failedPayments` files. **Fixed in this pass**: `payment_cleared` and `payment_disputed` are now wired into `PaymentWebhookService` (the same webhook-driven hook point `payment_failed` already uses, via new optional `notifications`/`profileOwners` constructor deps, catch-and-log so a notification failure can never fail the webhook — mirroring `postLedgerEntry`/`runFailedPaymentWorkflow`'s identical established contract). Two new tests confirm both parties are notified on `payment.succeeded`/`payment.disputed`, and that the webhook still succeeds when notifications aren't wired at all. **Deliberately not fixed in this pass**: the remaining 15 event types. Wiring each would mean adding a `NotificationService` dependency (plus DI wiring plus test-fake updates) to eight or more different prior-sprint services spanning Sprints 5, 6, 11, 12, 14, 15, and 16 — a cross-cutting integration effort of comparable size to a dedicated sprint, not a bounded review-pass fix, and attempting all of it under review-pass time pressure risks destabilizing a large amount of already-shipped, already-tested code for a marginal, non-blocking gap (every event still has a ready template and classification; the events themselves are still fully auditable via each domain service's own existing `AuditService.record` calls). Documented here explicitly, not silently glossed over, as a real, prioritized recommendation for a dedicated follow-up pass — most naturally sequenced right after Sprint 17 while the templates/classification are still fresh context, but never claimed complete by this sprint's own status row.

Test count updated: 611/611 (12 net new over Sprint 16, not 9 — three review-pass tests: settlement-critical, and two `payment_cleared`/`payment_disputed` webhook-notification tests). Full `lint`/`typecheck`/`test`/`build`/`drizzle-kit check` re-run clean after all fixes. No new migration was needed — every fix in this pass was logic-only.

### Sprint 16 Product Owner review pass — both documented limitations confirmed out of scope, no fixes required, no blocking issues

Independent re-review against `docs/sprints/SPRINT_16_Disputes.md` (the authoritative sprint spec, read in full again for this pass), `CLAUDE.md`, and this document, specifically re-examining the two limitations the implementation pass flagged rather than accepting them as-documented:

1. **"Denied" claim / stale `dispute_adjustment` ledger entry: confirmed correctly out of scope, not silently assumed.** The authoritative spec text never mentions a `"denied"` outcome, or any balance-restoration behavior for it, at all — the only relevant line is the generic "processor handles payment dispute outcome." The spec's own required test list is "reversal impact, balance update," both of which are fully implemented and tested for the paths the spec actually describes (a claim's reversal impact, and an upheld claim's refund) — `paymentDisputeService.test.ts`'s three "reversal impact / balance update" tests all pass against real, unmodified Sprint 10 `BalanceService`/`LedgerService` code. Fixing the "denied" case would require changing `BalanceService.reconstruct`'s `wasReversed` check from presence-based ("has any `refund`/`reversal`/`dispute_adjustment` entry ever existed for this payment") to a net-effect/order-aware check — verified directly against `balanceService.ts`: there is no existing ledger-entry type or method in `LedgerService`'s fixed vocabulary (`payment_cleared | refund | reversal | payout | dispute_adjustment | admin_adjustment`) capable of "un-reversing" a payment without that deeper change, since `admin_adjustment` entries are deliberately excluded from `wasReversed`'s check too. That is a change to Sprint 10's own core balance-reconstruction algorithm — for every prior reversal/refund/return scenario across Sprints 10–13, not just this sprint's new caller — which is a materially different (and materially riskier) kind of change than "wire an existing method to a new caller," the bar this codebase's prior review passes have used to justify touching a prior sprint's file (e.g. Sprint 13's real, narrowly-scoped `payment_method` bug fix). Not fixed.
2. **`restrictDispute` not enforced by payment scheduling: confirmed correctly out of scope, and confirmed to be a pre-existing, cross-sprint gap — not something Sprint 16 introduced.** The "scheduled payments continue unless authorization is revoked, both parties agree to pause, or processor/admin restriction applies" sentence sits as connective prose between the Agreement Dispute and Payment Dispute field-bullet lists in the spec, not as its own required-functionality bullet (unlike, say, Sprint 15's literal, unambiguous "Call Sprint 2's `requireStepUp`" instruction, which that sprint's own review pass correctly treated as a concrete build requirement it had under-implemented). To test whether "restriction blocks payments" is uniquely Sprint 16's obligation, the other two conditions in the same sentence were checked directly against the code: mandate revocation *is* already enforced (`AchPaymentService.requireActiveMandate`, Sprint 11) — but "both parties agree to pause" is not: an applied `temporary_pause` amendment (Sprint 14) sets `agreement.status = "paused_by_amendment"`, and a repo-wide search confirms no payment-scheduling code (`PaymentService`/`AchPaymentService`/`DebitCardPaymentService`/`PaymentRetryService`) anywhere checks `agreement.status` before scheduling or submitting a payment. This is a real, previously unflagged gap dating to Sprint 14, not something introduced or newly exposed by Sprint 16 — Sprint 14's own known-limitations note ("pause resumption is not automated") assumed the pause itself already had a blocking effect, which it does not. Since the identical class of gap already existed, unflagged, for two conditions in this same sentence before Sprint 16 began, retroactively closing only the `restricted` third of it as part of this sprint — while leaving the `paused_by_amendment` third open — would be inconsistent, narrower-than-real-fix scope creep into Sprint 5/9/11/12/13/14's own shipped payment-scheduling code, not a Sprint 16 deliverable. The correct fix is a single, dedicated future sprint adding one shared pre-scheduling gate that checks both conditions together, not two piecemeal patches. Not fixed; documented as a real, load-bearing, cross-sprint open issue (already the case in the implementation notes above), now with this cross-check as supporting evidence.

No code changes were required by this review pass. Test count unchanged: 599/599. Full `lint`/`typecheck`/`test`/`build`/`drizzle-kit check` re-run clean.

### Sprint 15 implementation notes

**Both `partial_payment_request` and `settlement_proposal` collapse `docs/STATE_MACHINES.md` §5/§6's illustrative sub-states, mirroring Sprint 14's own "single table, no indirection layer" precedent — a deliberate scope decision, not an oversight.** §5's `Submitted`/`UnderCreditorReview` become one status (`proposed`) and `Approved`/`AwaitingPayment` become one (`awaiting_payment`); §6's `AmendmentInProgress` sub-phase (a hand-off to `AmendmentService`, producing a new `agreement_version`) is never modeled at all — this sprint's own instruction text never mentions a signature step or a new version for a settlement, unlike Sprint 14's amendments, which are explicitly dual-signed. A settlement's own `proposed → accepted → awaiting_payment` is entirely self-contained on `settlement_proposal`; nothing in `SettlementService` ever calls `AmendmentService` or creates an `agreement_version`. Nothing master-spec-required is dropped by this — every §11/§12 field is captured — only the extra negotiation-layer indirection is.

**Master spec §11 restricts partial-payment proposal/decision more narrowly than Sprint 14's amendment (either party may propose).** "The borrower submits... the creditor may accept, reject, or counteroffer" is enforced as a hard `role !== "debtor"` check in `proposePartialPayment` (`ForbiddenError`) — there is no code path for a creditor-originated partial payment proposal. Settlement, by contrast, follows master spec §12's "the creditor and borrower may mutually agree" and Sprint 14's flexible-proposer precedent exactly: either role may call `proposeSettlement`.

**"Acceptance of a partial payment must not automatically constitute full settlement" / "the remaining balance stays due unless expressly forgiven" is enforced by construction, not a runtime check** — nothing in `PartialPaymentService` ever writes to `agreement.status`, `agreement.current_version_id`, or creates an `agreement_version`; `remainder_treatment` is only ever a free-text record on the request row. Forgiving any part of the remaining balance is exclusively `SettlementService`'s concern, a wholly separate negotiation with its own explicit `forgivenAmountMinorUnits` field.

**"After the settlement successfully clears, the status must be Settled in Full rather than Paid in Full" is enforced by construction.** `SettlementService.recordSettlementPayment` is the only place in this class that ever calls `agreements.updateStatus`, and it only ever passes `"settled_in_full"` — there is no code path in `SettlementService` capable of writing `"paid_in_full"` (that value is written exclusively by Sprint 5's own `AgreementService`, for an unrelated full-balance-clears path). A test asserts both the positive (`"settled_in_full"`) and the negative (`not.toBe("paid_in_full")`) directly.

**Settlement payment collection reuses the existing Sprint 9–13 payment gate rather than adding a parallel money-movement path** — `payment.ts`'s own Sprint 11 doc comment already reserved `installmentScheduleItemId: null` for exactly this ("any future extra/settlement payment (Sprint 15+) have no specific installment to link to"). `SettlementService`/`PartialPaymentService` never call a payment provider directly; both only ever accept an already-`succeeded` `payment_attempt` id (via a narrow, consumer-defined `PaymentAttemptReader` interface, mirroring this codebase's interface-segregation precedent) and link it in — the actual charge is created through whichever existing rail (`PaymentService`, `AchPaymentService`, `DebitCardPaymentService`) the caller used. A new `settlement_payment` join table (unique on `payment_attempt_id`, so a payment can never be double-counted toward two settlements) supports §12's "one-time vs. scheduled" by summing every linked cleared payment rather than assuming exactly one.

**Failure-consequence resolution is deliberately declarative, not a ledger rewrite.** §12's four options (`restore_original`, `restore_stated`, `forgive_permanently`, `prior_agreement_controls`) are recorded on `settlement_proposal.resolved_*` columns by `expireOverdueSettlements` (the Sprint 13-precedent cron entry point), never by mutating any ledger/balance table this codebase's Sprint 10 already owns. `restore_original` accounts for partial settlement payments already cleared before the deadline passed (`preSettlementBalance − totalCollected`, so a debtor who paid most of the settlement isn't double-charged for it); `restore_stated`/`forgive_permanently` replay exactly the stated amount captured at proposal time (never a value chosen at failure time, per `docs/STATE_MACHINES.md` §6's own "the system cannot substitute a different consequence at failure time"); `prior_agreement_controls` resolves to nothing numeric — the agreement's own status/terms were never touched during the failed negotiation, so "the prior agreement remains controlling" is already true without any code path needing to do anything.

**The initial literal step-up scoping was found to be a real gap during this sprint's own Product Owner review pass and fixed — see "Sprint 15 Product Owner review pass" below.** The first implementation pass gated only `role === "creditor" && decision === "accept"`; the review pass widened this to every creditor action capable of fixing binding-capable settlement terms.

**Cron-firing entry point combines both new expirations into one route, `POST /api/scheduler/expire-negotiations`**, mirroring Sprint 13's `retry-failed-payments` route exactly (same `CRON_SECRET` Bearer auth, same `timingSafeStringEqual`, same unauthenticated-but-signature-gated shape) rather than standing up two near-identical routes for one new daily `vercel.json` cron entry.

**No UI was built** (this sprint's file has no "UI" bullet, matching Sprints 4/6/7/8/11/12/13/14's precedent). Seven new routes, all `requireSession` + zod + `withErrorHandling` (except the cron route, `CRON_SECRET`-gated with no `requireSession`, matching Sprint 13's precedent): `POST /api/agreements/partial-payments/{propose,decide,record-payment}`, `POST /api/agreements/settlements/{propose,decide,record-payment}`, `POST /api/scheduler/expire-negotiations`.

### Sprint 15 Product Owner review pass — settlement step-up/capability conclusion, TypeScript gate conclusion, two fixes, no blocking issues

Independent re-review against `docs/sprints/SPRINT_15_ PartialPayments_Settlement.md`, `CLAUDE.md`, and this document, specifically scrutinizing two flagged questions before committing:

1. **Settlement step-up authorization conclusion: real gap, fixed — the literal "creditor accepts" reading was too narrow.** This sprint's instruction text names one example action ("before finalizing creditor acceptance of a settlement"), but master spec §17 requires "elevated authentication and authorization" for "significant settlements" — the settlement itself, not one specific click — and §26 separately lists both "Approving settlements" and "Forgiving debt" among the actions requiring MFA. Read against that broader intent, gating only `decideSettlement`'s "accept" branch left two real, exploitable paths: (a) a creditor could `proposeSettlement` with any forgiveness amount, and the debtor's ordinary "accept" (never creditor-gated) would bind it — the creditor's step-up gate was never exercised at all; (b) a creditor could `counter` a debtor's proposal with new binding-capable terms, and the debtor's "accept" would likewise bind it. Both are now closed: `proposeSettlement` and `decideSettlement`'s "counter" branch call the same shared `requireCreditorStepUp` helper `decideSettlement`'s "accept" branch already used — still exactly one authentication mechanism (`MfaService.requireStepUp`), never a second, competing one, per this sprint's own explicit instruction. **A second, closely related gap was found by the same reasoning and fixed alongside it**: `approve_settlement` (the Sprint 4 capability) had the identical bypass — a business-staff creditor member without that capability could still bind the business to a settlement merely by proposing terms the debtor accepts, since `decideSettlement`'s capability check only ever fired when the *creditor* was deciding. `proposeSettlement` now also calls `requireCreditorCapability(..., "approve_settlement")` when the proposer is the creditor. Four new tests cover: a creditor proposal blocked without step-up, a creditor counter blocked without step-up, the debtor's own propose/counter/accept paths confirmed still ungated (and confirmed *not* to leak a creditor's earlier step-up forward into a later, separate gated action), and a business-staff creditor without `approve_settlement` blocked from proposing (mirroring the existing decide-path test). 25 settlement tests total (up from 21), all passing.
2. **TypeScript gate conclusion: not a real error, not a Sprint 15 regression — a build-ordering artifact of this project's own tooling, confirmed and explained, not silently dismissed.** `package.json`'s `"typecheck": "tsc --noEmit"` is this project's own authoritative type-check gate. `tsconfig.json`'s `include` lists `.next/types/**/*.ts`, which Next.js generates only during `next build`/`next dev` — never present in a freshly created worktree before either has run once. Running `npx tsc --noEmit` in that state reports `Cannot find name 'LayoutProps'` in `src/app/layout.tsx`, a Next-generated global type. Confirmed three ways: (a) `git diff`/`git status` show `src/app/layout.tsx` byte-identical to `origin/master`'s tip — untouched by Sprint 15; (b) re-running `npm run typecheck` after this session's own `next build` had already generated `.next/types` reports **0 errors**; (c) `npm run build`'s own internal TypeScript pass — which always runs after Next's codegen, in the correct order — was clean both before and after this review pass's fixes. No code was changed for this finding, per "do not modify unrelated pre-existing code unless required by the authoritative gate" — the authoritative gate does not require it, since the gate itself is clean once run in the correct order.

Test count updated: 576/576 (38 net new over Sprint 14, not 34 — the 4 review-pass tests). Full `lint`/`typecheck`/`test`/`build`/`drizzle-kit check` re-run clean after both fixes.

### Sprint 14 implementation notes

**Single-table `amendment` model instead of `docs/DATA_MODEL.md` §4's illustrative two-table `amendment` + `hardship_request` split — a deliberate scope decision, not an oversight.** `docs/STATE_MACHINES.md` §4's Hardship request machine (`Submitted → UnderCreditorReview → Accepted → AmendmentInProgress → Closed`) describes a negotiation-then-handoff layer distinct from the Amendment lifecycle's own `Proposed` accept/reject/counter. This sprint's own instruction text and required-test list (proposal/rejection/counter/dual acceptance/version creation/original preserved/unauthorized change blocked) are 100% Amendment-lifecycle-shaped and never reference a separate hand-off state machine. Rather than build both layers with a redundant negotiation step at each, `AmendmentService`'s own `Proposed`-stage accept/reject/counter directly serves master spec §9's "creditor may accept/reject/counteroffer" for hardship-motivated proposals too — every field §9 requires a hardship request to carry (reason, requested relief, proposed effective date, proposed replacement terms) lives directly on the `amendment` row via `change_type`, `reason`, `requested_relief`, `proposed_effective_date`, and `terms`. Nothing master-spec-required is dropped; only the extra indirection layer is. A future sprint wanting the fuller two-state-machine hand-off (e.g., if hardship negotiation needs to diverge from general-amendment negotiation) can add a `hardship_request` table pointing at this same `amendment` table without needing this sprint's work redone.

**"No interest, no penalty growth" is enforced by construction, not a runtime check** — `AgreementTerms` (`src/lib/agreements/agreementService.ts`, Sprint 5) has no interest-rate or penalty field anywhere in this codebase for an amendment's proposed terms to populate even if it tried; `AmendmentService` reuses that exact same type and `buildTerms`/`computeSchedule` validation, so there is no separate code path where such a field could be smuggled in.

**"Until both parties approve/sign: the existing agreement remains controlling" is also structural, not just tested** — `AmendmentService` never calls `agreements.setCurrentVersionId`, `agreements.updateStatus`, or `versions.insert` from anywhere except the private `applyAmendment` method, which only `signAmendment` calls, which only runs after observing both `creditorSignedAt` and `debtorSignedAt` on the amendment row. Every earlier step (propose/accept/reject/counter) touches only the `amendment` table.

**Counter mutates the same `amendment` row in place, exactly mirroring `AgreementService.creditorDecide`'s identical pre-signature counter mechanic for the original agreement** — not a new row, not a new state. `proposing_party_role` flips to whichever party countered, so `decideAmendment`'s "the proposer cannot decide their own proposal" check (the concrete mechanism behind "unauthorized change blocked") automatically requires the *other* party to respond to a counter too, with no extra logic needed for that case.

**`buildTerms` was exported from `agreementService.ts`** (previously module-private) so `AmendmentService` validates/computes proposed terms through the exact same path the original draft and Sprint 5's own counter flow already use, rather than duplicating that validation. The only other production-code touch outside `src/lib/amendments/`.

**Authorization and signature-evidence: see "Sprint 14 Product Owner review pass" below** — both were flagged here as known limitations in the first implementation pass; the review pass found the authorization gap was real and fixed it, and confirmed the signature-evidence gap is a deliberate, bounded scope decision (with one small real improvement made) rather than a silent omission.

**Known limitation: pause resumption is not automated** — an applied `temporary_pause` amendment transitions the agreement to `paused_by_amendment` (`docs/STATE_MACHINES.md` §1), but nothing automatically transitions it back to `active` once the pause period (captured in `proposed_effective_date`/`terms`) ends — `docs/STATE_MACHINES.md` §1's own "pause period ends per amendment terms" transition would need a scheduler hook, naturally extending Sprint 13's cron-route pattern; out of this sprint's explicit scope.

**No UI was built** (this sprint's file has no "UI" bullet, matching Sprints 4/6/7/8/11/12/13's precedent). Four new routes, all `requireSession` + zod + `withErrorHandling`, matching every other route in this codebase: `POST /api/agreements/amendments/{propose,decide,sign,withdraw}`.

### Sprint 13 implementation notes

**Two real, pre-existing bugs were found and fixed while building this sprint's own tests, not just described.** (1) `PaymentWebhookService.applyEvent` (Sprint 9) always called `updateStatus(payment.id, newStatus, {})` — the empty object silently discarded `data.failureCategory` on every `"payment.failed"` webhook since Sprint 9; no non-sensitive failure category was ever actually stored, only ever asserted on `status` by Sprint 11's own ACH tests. Fixed by threading `failureCategory` into the `failureReason` update, which this sprint's own requirement #3 ("Display non-sensitive failure category") needed to be real. (2) `AchPaymentService` (Sprint 11) never set `payment_attempt.payment_method` at all — only `DebitCardPaymentService` (Sprint 12) did — so master spec §6's "must separately track ACH and card payment states" was only half-implemented, and this sprint's own retry-firing logic (which needs to know which method-specific service to retry through) failed its own first test run with "Original payment attempt not found or has no recorded payment method" until fixed. Both fixes are purely additive (a previously-always-empty object now sometimes has one key; a previously-unset nullable column now gets set) — verified by re-running Sprints 1–12's own test suites unchanged afterward.

**`payment_retry` is a separate table from `payment_attempt`, not an `attempt_kind` column** (the illustrative shape in `docs/DATA_MODEL.md` §4) — a retry's own resulting charge is an ordinary `payment_attempt` row, created through the exact same `AchPaymentService`/`DebitCardPaymentService.createManualPayment` gate any manual payment uses (never a separate/parallel path — the concrete mechanism behind "never implement uncontrolled retries": a retry cannot bypass mandate/card-on-file/verification checks). `payment_retry`'s own existence is what "was this a retry" means, via `resulting_payment_attempt_id`. "If retry fails, stop automatic retries" / "no third automatic retry" is enforced two independent ways: `PaymentRetryService.scheduleRetryForFailedPayment` refuses a second row for the same original attempt (`findByOriginalPaymentAttemptId`) *and* refuses to schedule a retry for a payment that is itself already a retry's own result (`findByResultingPaymentAttemptId`) — so even the retry's own failure, flowing back through the identical webhook hook, cannot recurse. `payment_retry.original_payment_attempt_id` carries a unique DB index as the same guarantee's race-safe backstop, mirroring Sprint 9/11's idempotency-key precedent.

**`createManualPayment` (both `AchPaymentService` and `DebitCardPaymentService`) gained an optional `installmentScheduleItemId` parameter.** Sprint 11 designed manual payments as deliberately "not tied to a specific due installment" — but this sprint's requirement #7 ("Cancel retry if manual payment succeeds") needs to know *which* installment a manual payment is covering, to know which pending retry to cancel. Omitted, a manual payment behaves exactly as before (untied, Sprint 11's original semantics); provided, `PaymentWebhookService`'s existing "succeeded" hook can find and cancel the matching `payment_retry` row. The retry-firing path itself also passes this through, so a retry's own resulting charge stays linked to its installment (meaning if the retry itself later fails, the normal past_due/notify hook still applies to it — it just never schedules a second retry, per the guarantee above).

**Installment status (`installment_schedule_item.status`) was never written by any prior sprint — a real, separate pre-existing gap, not something Sprint 5 was ever asked to build** (payments didn't exist at Sprint 5's time). This sprint's `InstallmentStatusRepository` is the first code to ever call `markPastDue`/`markPaid`, wired as an additive hook off the existing `PaymentWebhookService` (mirrors Sprint 10's ledger-posting integration precedent exactly — one new optional constructor dependency, `failedPaymentWorkflow?: FailedPaymentWorkflow`, so Sprints 1–12's own tests constructing `PaymentWebhookService`/`createTestPaymentWebhookService` without it are completely unaffected).

**Notification is the minimal internal event ledger `docs/SPRINT_CONTROL.md`'s own "Sequencing risk 1" resolution called for** (`src/lib/notify/notificationService.ts`) — every call durably records a `notification_event` row first, then attempts best-effort delivery through the existing `EmailSender` (`ConsoleEmailSender`, Sprint 2's placeholder — no code changes needed when Sprint 17 wires a real provider, matching that sprint's own stated intent). A missing/undeliverable email address is not an error: the durable record is the artifact this sprint's requirement #2 ("Notify both parties") actually needs; delivery is Sprint 17's concern layered on top of these same rows.

**Reschedule approval authorization is deliberately narrower than `AgreementService.creditorDecide`'s.** `RescheduleRequestService` checks only the agreement's creditor profile's *owning user* (`ProfileOwnerReader`), not Sprint 4's fuller business-staff delegated-capability model a B2B creditor's other agreement decisions integrate with. A staff member with delegated approval authority cannot decide a reschedule request in this sprint — only the creditor profile's owner can. Documented as a known limitation rather than silently assumed; extending this to Sprint 4's capability model is a natural, self-contained follow-up if needed.

**No automatic late fees were implemented anywhere** (explicit requirement) — nothing in this sprint's code path computes or posts a fee for a late/failed/rescheduled payment; the only amounts ever charged are the original `amountMinorUnits` on the retry (identical to the original attempt) or whatever `RescheduleRequestService` — which never touches money at all, only a due date — leaves untouched.

**"Preserve original installment record"**: no code path in this sprint ever deletes a `payment_attempt`, `payment_retry`, or `reschedule_request` row, or mutates a `payment_attempt`'s historical fields. The one field this sprint does mutate going forward is `installment_schedule_item.due_date`, and only inside `RescheduleRequestService.decideReschedule`'s approved branch — every such change is preceded by a durable `reschedule_request` row recording the prior (`current_due_date`) and new (`requested_due_date`) values, so the change's full history is reconstructable even though the live column value moves forward.

**Known limitation: no US federal holiday calendar** — `addBusinessDays` (`src/lib/failedPayments/businessDays.ts`) skips only Saturday/Sunday. No holiday calendar is specified anywhere in this project's docs; documented here rather than silently assumed, consistent with this project's practice of flagging such simplifications (e.g. Sprint 10's caller-supplied processor fees).

**Known limitation: `vercel.json`'s cron schedule (`0 13 * * *`, once daily) is a reasonable default, not a contracted SLA** — sufficient given retries are scheduled ~3 business days out (a few hours of drift firing within the same day is immaterial), and compatible with Vercel Hobby-plan cron frequency limits; a Pro-plan deployment could run this more often if tighter timing is wanted.

**No UI was built** (this sprint's file has no "UI" bullet, matching Sprints 4/6/7/8/11/12's precedent). Three new routes: `POST /api/scheduler/retry-failed-payments` (cron-only, `CRON_SECRET`-gated, no `requireSession` — no user session is meaningful for a system-initiated call, mirroring the webhook route's own unauthenticated-but-signature-gated precedent), `POST /api/installments/reschedule/{request,decide}` (`requireSession` + zod + `withErrorHandling`, matching every other route in this codebase).

### Sprint 14 Product Owner review pass — authorization conclusion, signature-evidence conclusion, no blocking issues

Independent re-review against the sprint spec, CLAUDE.md, and this document, specifically scrutinizing the two limitations the first implementation pass flagged:

1. **Authorization review conclusion: real gap, fixed.** The first pass's "any active party/staff member, not a specific capability" limitation for `decideAmendment` was a genuine authorization gap, not an acceptable simplification — Sprint 5's original agreement decision (`creditorDecide`) requires `approve_agreement` specifically so a business owner can restrict which staff may approve binding changes, and "unauthorized change blocked" is one of this sprint's own required test categories. Fixed by adding `AgreementService.requireCreditorCapability` (new, small, additive public method mirroring `resolvePartyRole`'s existing pattern) and calling it from `decideAmendment` whenever the responding party is the creditor. `proposeAmendment`/`signAmendment`/`withdrawAmendment` intentionally remain capability-free, matching Sprint 5's own asymmetric precedent (debtor-side actions and signing have no dedicated capability in Sprint 4's fixed 13-capability list). New test: a viewer-role staff member is correctly blocked; a manager (who holds `approve_agreement`) succeeds.
2. **Signature-evidence review conclusion: deliberate, bounded scope decision — confirmed, not silently narrowed — plus one small real fix.** `docs/STATE_MACHINES.md` §3's "signature capture (FR-SIG-001) is mandatory for every amendment, same as the original agreement" was checked against Sprint 14's own instruction text, which never mentions step-up MFA, identity verification, or IP/device/consent capture — unlike, say, Sprint 15's row in `docs/SPRINT_REQUIREMENTS_MATRIX.md`, which explicitly calls out reusing Sprint 2's `requireStepUp`. Fully integrating Sprint 6's `SignatureService` (step-up, `isFullyVerified`, IP/device/consent capture, PDF regeneration) would be substantial new scope beyond a review pass, not a small fix, and risks exactly the "do not begin Sprint 15" scope creep this stage's instructions guard against — so it remains a documented, unfixed boundary, not silently narrowed. What *was* cheap and worth fixing: `recordAudit` was hardcoding `ipAddress`/`deviceInfo` to `null` for every amendment action, including signing — the single highest-evidentiary-value action in this flow. `signAmendment` now accepts optional `ipAddress`/`deviceInfo`, and the sign route captures them via the same `getClientIp`/`user-agent` pattern every other route in this codebase uses, recording them on both signing-related audit entries. New test confirms this.

Test count updated: 538/538 (14 net new over Sprint 13, not 12 — the two review-pass tests). Full `lint`/`typecheck`/`test`/`build`/`drizzle-kit check` re-run clean after both fixes.

### Sprint 13 Product Owner review pass — two fixes, no blocking issues

Independent re-review against the sprint spec, CLAUDE.md, and this document found no blocking issues, but did find and fix two real gaps before commit:

1. **The cron route compared `CRON_SECRET` with a plain `!==`**, unlike every other secret comparison in this codebase (`src/lib/webhookSignature.ts`'s `verifyHmacSignature` uses `crypto.timingSafeEqual`). Fixed with a matching constant-time comparison (`timingSafeStringEqual`) in `src/app/api/scheduler/retry-failed-payments/route.ts` — a minor timing-attack surface, not a functional bug, but inconsistent with this project's own established security posture for secret comparisons.
2. **`RescheduleRequestService.requestReschedule` never validated that the requested due date was actually after the installment's current due date** — a borrower could technically "request" moving a payment earlier or to the same date. Fixed with a same-or-earlier rejection (`ValidationError`) in `src/lib/failedPayments/rescheduleRequestService.ts`, with a new test covering both the same-date and earlier-date cases.

Test count updated: 524/524 (20 net new over Sprint 12, not 19 — the added validation test). Full `lint`/`typecheck`/`test`/`build`/`drizzle-kit check` re-run clean after both fixes.

### Sprint 12 implementation notes

**No `SandboxPaymentProvider`/`PaymentProvider` interface change was needed at all.** Sprint 9's abstraction already anticipated a card method (`CreatePaymentMethodTokenInput.methodKind: "ach" | "debit_card"`), and the sandbox provider's `createPayment`/`simulateOutcome` mechanism is already payment-method-agnostic. The only two production-code touches to Sprint 9/10/11's own files were: (1) a new nullable `paymentMethod` field threaded through `PaymentAttemptRecord`/`PaymentAttemptRepository`/`PaymentService.createPayment`/`schedulePayment` (additive — every existing caller that doesn't pass it gets `null`, unchanged from before), needed because master spec §6 explicitly requires "The system must separately track ACH and card payment states," which had no way to distinguish a card attempt from an ACH one at the row level until now; and (2) two new entries in `PaymentWebhookService`'s existing `EVENT_TYPE_TO_STATUS`/`EVENT_TYPE_TO_REVERSAL_ENTRY` lookup maps (`"payment.reversed"` → `"reversed"` status / `"reversal"` ledger entry), activating the `"reversed"` status value Sprint 10 reserved and Sprint 11 confirmed is a card-only concept. `LedgerService` itself required zero changes — `reversePayment`'s existing pre/post-payout auto-selection already handles a card chargeback identically to an ACH return, per `docs/PAYMENT_ARCHITECTURE.md` §10's "all three [return, chargeback, refund] converge on the same ledger operation."

**`DebitCardMethodService`/`DebitCardPaymentService` (`src/lib/debitCard/`) mirror `AchMandateService`/`AchPaymentService` structurally, including the same "structurally incapable of touching ledger/balance/agreement data" guarantee** — `DebitCardMethodService`'s constructor depends only on its own repository, `ProfileOwnerReader`, and `AuditService`; `DebitCardPaymentService` never calls `PaymentProvider` directly, only ever through `PaymentService.schedulePayment`/`submitPending`, the same two-phase gate ACH uses. "Replaced card" is `replaceCard` (mirrors `handleBankChange`): marks the old `debit_card_method` row `"replaced"` and inserts a new row linked back via `supersedesCardMethodId` — append-only, same as `ach_mandate`.

**"Expired card" is a lazy, read-time check, never a stored transition** — `debitCardMethodStatusEnum`'s `"expired"` value is reserved but never set by this sprint's code, exactly mirroring `achMandateStatusEnum`'s "expired reserved, never set directly" precedent. `DebitCardMethodService.isCardExpired(card, now)` compares `expiresAtMonth`/`expiresAtYear` against the given date (a card is valid through the last day of its expiry month); `registerCard`/`replaceCard` additionally refuse to register an already-expired card at write time (a defensive check found and added during this sprint's own test run — see "verified, not assumed" below), and `DebitCardPaymentService.scheduleInstallmentPayment`/`createManualPayment` refuse to schedule a payment against a card that has since expired.

**Fee-allocation engine (`src/lib/debitCard/cardFeeAllocation.ts`) implements exactly this sprint's stated rule, nothing broader.** Master spec §6 / this sprint's file: "the borrower pays the incremental processor cost unless the signed agreement or mutual amendment states otherwise. Do not silently reduce creditor net proceeds." No Sprint 14/15 amendment mechanism exists yet to add a separate override field, so "the signed agreement... states otherwise" resolves against the agreement's own, already-existing `feeAllocation` term (Sprint 5, `agreement_version.feeAllocation`): `"creditor_pays"` means the creditor already contractually agreed to bear all processing costs including any method's fee, so the borrower surcharge is zero; `"debtor_pays"`/`"split_evenly"` both result in the borrower being surcharged exactly the incremental cost (card fee minus a zero-fee ACH baseline — this project's ACH code has never simulated a processor fee at all, per Sprint 9–11's own ledger tests, so that baseline is the pre-existing status quo, not a new assumption). The surcharge is charged on top of the scheduled amount (added to what `PaymentService.createPayment`'s `amountMinorUnits` actually collects), not implemented as a ledger-only bookkeeping split — this is the concrete mechanism behind "must not silently reduce creditor net proceeds": the larger gross entering `LedgerService.postPaymentCleared` still nets the creditor the original scheduled amount after the same processor fee is subtracted. `DebitCardPaymentService.computeChargeBreakdown` is exposed separately so a caller/route can show the borrower this breakdown before they confirm, since "must not silently reduce" requires the surcharge to be visible, not just applied.

**Known limitation: the processor-fee rates are sandbox-only illustrative constants (2.9% + $0.30 for card, $0 flat for ACH), not processor-derived** — same documented-gap precedent as Sprint 10's "processor fee amounts are caller-supplied, not processor-derived." No live processor exists to source real rates from (open decision #3, unchanged).

**Known limitation: card decline is tested via the same asynchronous `payment.failed` webhook path Sprint 11's ACH decline test uses, not a synchronous provider response**, even though `docs/PAYMENT_STATE_MACHINE.md` §1.1 notes a real card decline is typically near-immediate at authorization time. `DebitCardPaymentService` always goes through `PaymentService.schedulePayment`/`submitPending` (matching `AchPaymentService`'s exact contract), which does not expose `SandboxPaymentProvider`'s synchronous `simulateOutcome` hook to a method-specific service caller. The webhook-driven decline path this sprint tests is exactly what a real card adapter's decline would also flow through if it arrived asynchronously (or what any caller using `PaymentService.createPayment` directly with `simulateOutcome: "failed"` would exercise synchronously) — no code path differs, only the sandbox test's timing model.

**Verified, not assumed: registering an already-expired card is rejected.** This sprint's own test run initially exposed that the first implementation only validated an expiry date's *shape* (month 1–12, a plausible year), not whether it was already in the past — caught by `debitCardMethodService.test.ts`'s "rejects registering an already-expired card" test actually failing against the real (unmocked) `isExpired` check, not asserted from the description alone. Fixed by having `registerCard`/`replaceCard` reject an already-past expiry outright; the "card that was valid at registration but has since expired" scenario (the realistic case `DebitCardPaymentService`'s pre-flight check exists for) is exercised separately, by inserting directly through the repository to simulate time having passed.

**No UI was built** (this sprint's file has no "UI" bullet, matching Sprints 4/6/7/8/11's precedent). Five new routes, all `runtime="nodejs"`, `dynamic="force-dynamic"`, `requireSession` + zod + `withErrorHandling`, mirroring ACH's route shapes exactly: `POST /api/debit-card/register`, `POST /api/debit-card/replace`, `POST /api/debit-card/payments/{schedule,submit,manual}`. No new webhook route — card events flow through the same generic `POST /api/payments/webhook` Sprint 9 already built (payment-method-agnostic by construction). No route-level tests were added, matching the established precedent that ACH's own routes (Sprint 11) have none either — coverage lives entirely at the service layer, which the route handlers are thin, already-audited wrappers around (`requireSession` → zod → the shared `create*Handler` factory pattern used by every route in this codebase).

### Sprint 11 implementation notes

**Cross-checking the sprint's terse state list against `docs/PAYMENT_STATE_MACHINE.md` (the canonical,
detailed reference) surfaced and fixed a real Sprint 10 naming error.** Sprint 10 added a
`payment_attempt_status` value `"reversed"`, documented as covering "a bank/network-initiated return
(e.g. late ACH return)." The canonical doc's §1 state diagram defines `Returned` (late ACH return)
and `Reversed` (card/network chargeback) as two distinct states — and its own method-nuance table
says `Reversed` is explicitly *not applicable* to ACH. Sprint 10 had the right ledger-entry-type
label (`reversal`, already correctly scoped) but the wrong payment-status name. This sprint adds a
correctly-named `"returned"` status value (additive `ALTER TYPE`), repoints the existing
`payment.returned` webhook event to set it, and updates the one existing Sprint 10 test and the
reconciliation exception mapping that referenced the old name. `"reversed"` remains in the enum,
reserved for Sprint 12 (debit card chargebacks) — nothing currently sets it.

**The granular pre-clearing lifecycle (`scheduled`/`submitted`/`processing`) is additive to
`payment_attempt_status`, not a replacement of Sprint 9's `"pending"`.** `"pending"` remains valid
for payment methods/tests that don't need this granularity (Sprint 9's sandbox default still uses
it). `"succeeded"` continues to mean "Cleared," unchanged. Sprint 10's `LedgerService`,
`BalanceService`, and `ReconciliationService` needed exactly one small update:
`missing_provider_transaction` now also excludes `"scheduled"` (a scheduled-but-not-yet-submitted
payment legitimately has no provider reference yet) — everything else in those three services was
already written generically enough (keying off `"succeeded"`/specific ledger entry types, never an
exhaustive status switch) to need no other change.

**Payout-pending granularity reuses Sprint 10's own precedent (a timestamp, not a status value) —
`payoutInitiatedAt` alongside the existing `payoutCompletedAt`.** `docs/PAYMENT_STATE_MACHINE.md` §2
models payout as its own small state machine layered on top of the payment's — treating it as an
orthogonal timestamp pair (null/null = not yet payout-pending, set/null = PayoutPending, set/set =
PaidOut) avoids overloading `payment_attempt.status` with a concern that isn't really part of the
payment's own lifecycle, consistent with why Sprint 10 didn't add a `payout_in_transit` ledger
account either.

**Two-phase payment creation required one deliberate, minimal extension to Sprint 9's
`PaymentService`, not a bypass of it.** `PaymentService.schedulePayment`/`submitPending` are new
methods that share the *exact* idempotency/ownership/verification gate `createPayment` already had
— extracted into a private `reserveAttempt` helper both paths call — so there remains exactly one
way to reach the payment provider through a verification check, matching Sprint 9's own explicit
"individual provider adapters ... must not be able to bypass this by calling a PaymentProvider
directly" invariant. `AchPaymentService` never touches `PaymentProvider` and has no dependency
capable of doing so (proven structurally in `achPaymentService.test.ts`).

**`AchMandateService` is structurally incapable of touching ledger, balance, or agreement data** —
its constructor depends only on its own mandate repository, `ProfileOwnerReader`, and `AuditService`.
This is the concrete mechanism behind "revoking authorization stops future automatic debits but does
not erase debt": revocation literally cannot write to anything representing the debt. Enforcement
that a revoked mandate blocks *new* debits lives in `AchPaymentService` (checks mandate state before
scheduling), not in the mandate service itself.

**Mandates are append-only, matching every other table in this schema.** `handleBankChange` never
mutates an existing mandate's `bank_account_ref` — it revokes the old row and inserts a new one
linked back via `supersedes_mandate_id`, preserving the full authorization history an
unauthorized-payment claim would need (mirroring FR-UPAY-003's evidence requirements).

**Duplicate-debit prevention is two independent mechanisms, not one.** `AchPaymentService` checks
for an existing *open* (unresolved) attempt per installment before scheduling — a defensive,
clear-error-message check. The race-safe backstop is the same one Sprint 9 already built:
`payment_attempt.idempotency_key`'s DB-level uniqueness, which is race-safe under concurrent
requests where the pre-check alone would not be; callers are expected to derive a deterministic key
from the installment id for this to apply. A payment that already reached a *terminal* state
(succeeded, failed, canceled, ...) does not block a new attempt — matching
`docs/PAYMENT_STATE_MACHINE.md`'s "a failed attempt is never mutated into a retry; a new row is
created."

**"No unsettled ACH funds may be treated as received by creditor" is enforced by construction, not
a new check.** `BalanceService` only counts a payment toward `amountPaidMinorUnits` once a
`payment_cleared` ledger entry exists, which only happens once `LedgerService.postPaymentCleared`
runs on a `payment.succeeded` webhook — a `scheduled`/`submitted`/`processing` attempt has no ledger
entries at all yet, so it is already correctly excluded; `achPaymentService.test.ts`'s "pending" test
proves this explicitly rather than assuming it.

**No UI was built** (this sprint's spec has no "UI" bullet, matching Sprint 4/6/7/8's precedent). Six
new routes: `POST /api/ach/mandate`, `POST /api/ach/mandate/revoke`, `POST /api/ach/mandate/bank-change`,
`POST /api/ach/payments/{schedule,submit,manual}`.

**Known limitation: NSF and other decline reasons are caller-supplied strings on the webhook
payload** (`failureReason`), not a closed, typed failure-category enum — matching
`docs/PAYMENT_ARCHITECTURE.md` §6's "non-sensitive failure categories" concept in spirit, but no
processor exists yet to define the real category vocabulary (open decision #3). A future sprint
wiring a real ACH processor would map its actual return-code taxonomy onto this field.

### Sprint 10 implementation notes

**No "debtor_obligation" ledger account exists — original principal is read directly from Sprint 5's
`agreement_version.terms.currentPrincipalMinorUnits`, never duplicated into the ledger.** This is
the concrete mechanism behind requirement #7 ("ledger activity must never rewrite agreement
principal, terms"): `BalanceService`'s `AgreementTermsReader` interface has exactly one method,
`getPrincipal` — there is no write method for `LedgerService` or `BalanceService` to call even by
mistake. `balanceService.test.ts`'s "never mutates the underlying agreement principal it reads" test
proves this behaviorally, not just structurally.

**The chart of accounts matches `docs/PAYMENT_ARCHITECTURE.md` §14 exactly, minus
`payout_in_transit`.** Payout is modeled as a single direct posting
(`creditor_proceeds_payable → processor_clearing`) rather than a two-step in-transit intermediate —
this sprint's payment_attempt model has no separate payout-attempt row to track a "submitted but not
yet confirmed" payout state, so the two-step model would have nothing real to represent. Every
account is scoped to exactly one `(account_type, agreement_id)` pair (`ledger_account`'s unique
index) — there is no platform-wide singleton account, so every balance is directly, deterministically
traceable to its agreement without any additional join.

**`refund` (voluntary/dispute-resolved) and `reversal` (bank/network-initiated return) are the same
accounting operation with different labels, auto-selecting pre-payout (full mirror of the clear
entry) or post-payout (`creditor_clawback_exposure`-only) shape based on whether a `payout` entry
already exists** — mirrors `docs/PAYMENT_ARCHITECTURE.md` §10's "all three [return, chargeback,
refund] converge on the same ledger operation." `dispute_adjustment` uses the identical shape for a
dispute that has been opened but not yet resolved. The post-payout shape claws back only the
creditor's net proceeds, not platform/processor fees already recognized — `docs/PAYMENT_ARCHITECTURE.md`
§14's own documented simplification, carried forward unchanged.

**Idempotency is enforced twice, independently.** `LedgerJournalEntryRepository`'s
`(payment_attempt_id, entry_type)` unique index means a payment can have at most one
`payment_cleared`, one `refund`, one `reversal`, one `payout`, one `dispute_adjustment`, and one
`admin_adjustment` — combined with Sprint 9's own webhook-event-id replay protection, a redelivered
webhook cannot double-post even if it somehow bypassed the event-level dedupe.
`paymentLedgerIntegration.test.ts`'s "never double-credits or double-debits" test delivers the same
signed webhook twice and asserts exactly one `payment_cleared` entry results.

**A ledger-posting failure never fails the webhook or rolls back the payment-status update that
already happened.** The most common cause in this sprint's own test suite: a payment created with no
`agreementId` (Sprint 9 made that field optional; Sprint 10's ledger requires one). This is caught,
logged (`payment_webhook_ledger_posting_failed` / `_skip_no_agreement`), and left for
`ReconciliationService`'s `internal_posting_failure` detector to surface as an explicit, visible
exception — proven end-to-end in `paymentLedgerIntegration.test.ts`'s last test, which creates
exactly this gap and then reconciles it into a real exception record, rather than treating the gap
as untestable.

**Reconciliation implements real, independent detection logic for all 10 of the sprint's required
exception types**, not a partial subset with placeholder vocabulary — see `reconciliationService.ts`'s
per-check doc comments and `reconciliationService.test.ts`'s one test per type.
`missing_provider_transaction` (we never captured a provider reference), `unmatched_provider_transaction`
(the provider itself doesn't recognize our reference — checked live against `PaymentProvider.retrievePayment`),
and `provider_event_without_internal_state` (a webhook references a payment we have no record of at
all) are three genuinely distinct conditions, not the same check under three names.
`duplicate_transaction` is a defensive, whole-table-scan check (`reconcileAll`) — the DB unique
constraint already prevents this via the normal application path, so it is only reachable in tests
by constructing data directly through the repository, which is exactly how it's tested.

**Reconciliation re-run idempotency is an application-level check
(`ReconciliationExceptionRepository.findOpen` before every insert), not a DB partial-unique-index** —
`payment_attempt_id` and `provider_event_id` are each independently nullable depending on exception
type, and this project hasn't otherwise depended on Drizzle 0.45's partial-index support elsewhere,
so this sprint didn't introduce that dependency for what is an administrative/batch operation, not a
concurrent-request hot path. Documented as an accepted, narrow race window in
`reconciliationService.ts`'s doc comment.

**Balance reconstruction treats a payment as "not paid toward the debtor's obligation" once *any*
reversal-type entry exists for it, regardless of pre- or post-payout shape** — `docs/PAYMENT_ARCHITECTURE.md`
§7's "reduce the agreement's recorded paid balance" applies to a late return whether or not payout
already happened; only *who bears the clawback exposure* differs (the ledger's own accounts), not
whether the debtor's payment still counts toward their obligation. `balanceService.test.ts`'s
"excludes a reversed payment... whether reversed pre- or post-payout" test proves both branches
produce the same debtor-facing result.

**Administrative corrections (`admin_adjustment`) are Platform Owner-only, not Platform Admin** —
stricter than this sprint's own read-only visibility (`platform_admin`+), mirroring Sprint 6A's own
precedent of gating money/role-affecting actions to Owner while read access is broader. Always
balanced against a dedicated `admin_adjustment_suspense` account (never fabricates a fake
counterparty movement), always requires a non-empty reason, and is capped at one adjustment per
payment in this sprint — `ledgerService.ts`'s doc comment explains why multiple sequential
corrections per payment were left out of scope rather than solved with a partial-unique-index.
`LedgerAdminService` is a new, separate file — Sprint 6A's `adminService.ts` was not touched at all;
only its already-audited `isAdminRole`/`isOwnerRole` helpers are reused.

**Five new admin routes, no new UI**: `GET /api/admin/ledger/agreement`,
`GET /api/admin/ledger/exceptions`, `POST /api/admin/ledger/exceptions/resolve`,
`POST /api/admin/ledger/reconcile` (all Platform Admin+), and `POST /api/admin/ledger/adjustment`
(Platform Owner only). None of them "edit" or "delete" a posted entry — proven structurally in
`ledgerAdminService.test.ts`.

**Known limitation: only full refunds/reversals are modeled, not partial ones.** Sprint 9's
`PaymentService.refundPayment` only ever refunds a payment's full amount, so this sprint's ledger
reversal shapes assume the same; `requirement #11`'s "partially refunded" state is not implemented.
A future sprint adding partial-refund support to `PaymentService` would need a corresponding
partial-amount reversal posting here.

**Known limitation: processor fee and platform fee amounts are caller-supplied, not
processor-derived.** Sprint 9's sandbox provider has no real fee-reporting capability (no live
processor is integrated); `PaymentWebhookService` reads `processorFeeMinorUnits`/
`platformFeeMinorUnits` directly from the webhook payload if present, defaulting to 0. A real
processor adapter (Sprint 11/12) would source these from the provider's own settlement/balance-transaction
report instead.

**No live processor or KYC/KYB provider account exists in this environment; every operation is a
deterministic local simulation.** `SandboxPaymentProvider`/`SandboxKycProvider`
(`src/lib/payments/sandboxPaymentProvider.ts`, `src/lib/kyc/sandboxKycProvider.ts`) never make a
network call — per this sprint's own "Do not fake successful external-provider execution where no
real sandbox/provider call occurred; report that limitation explicitly." The one piece of genuinely
real behavior is the webhook HMAC-SHA256 signing/verification (`src/lib/webhookSignature.ts`,
shared by both sandbox adapters) — that cryptography is correct and exercised by real
signature-mismatch tests, standing in for wherever a real processor's signing scheme would sit.
`docs/PAYMENT_ARCHITECTURE.md`'s new "Sprint 9: provider evaluation and sandbox implementation"
section carries the processor/KYC-provider recommendation and contingency — no provider has been
contacted or approved (open decisions #3 and #16 remain open).

**The payer/recipient full-verification gate is enforced exactly once, in
`PaymentService.createPayment`** (`src/lib/payments/paymentService.ts`), calling Sprint 3's
`VerificationService.isFullyVerified` for both profiles before ever calling the provider or
inserting a payment row — per this sprint's explicit instruction, individual provider adapters and
the future Sprint 10 ledger have no path to create a payment that bypasses this, since they never
call a `PaymentProvider` directly; they call `PaymentService`.

**Idempotency is two distinct mechanisms, exactly as `docs/PAYMENT_ARCHITECTURE.md` §11
describes.** Outbound: `payment_attempt.idempotency_key` is unique at the DB level;
`PaymentService.createPayment` checks for an existing record first, and on an insert race (two
concurrent requests with the same key) catches the failure and re-reads rather than erroring.
Inbound: `payment_webhook_event`/`kyc_webhook_event` are each uniquely keyed on
`(provider, provider_event_id)`; a redelivered webhook is detected before its business-logic effect
is ever reapplied, and reported back as `"duplicate"` rather than reprocessed or rejected (a
provider's retry loop must never see an error for a redelivery it's expected to send).

**The KYC/KYB integration extends Sprint 3's `verificationService.ts` additively, never rewriting
its existing behavior.** `IdentityVerificationRecordRepository.updateDecision`'s `reviewerUserId`
widened from `string` to `string | null` (the DB column was already nullable; every existing manual
call site still passes a string, so this is a backward-compatible loosening only). Two new methods —
`recordProviderSubmission` and `recordProviderVerificationDecision` — reuse the existing
`provider_ref` column (reserved for this sprint since Sprint 3) and the existing `pending` status
guard, giving "duplicate verification submission" and "profile stays gated while pending/rejected"
for free rather than reimplementing them. `isFullyVerified`, `getVerificationState`,
`submitFullVerificationRequest`, and `recordManualVerificationDecision` are byte-identical to
before this sprint — proven by every one of Sprint 3's original tests passing unchanged, plus new
tests exercising only the two additive methods.

**The two provider interfaces are deliberately never merged**, per the sprint's own instruction —
`PaymentProvider` (`src/lib/payments/paymentProvider.ts`) and `KycKybProvider`
(`src/lib/kyc/kycProvider.ts`) are separate files, separate sandbox adapters, and separate webhook
event tables (`payment_webhook_event` vs. `kyc_webhook_event`), even though both need the same
signature-verification/replay-protection shape — that shared *mechanism* (not domain interface) is
the one piece of legitimate reuse (`src/lib/webhookSignature.ts`).

**Government-ID, selfie/liveness, and bank-account-ownership checks are folded into one submission
call each** (`submitIndividualVerification`/`submitBusinessVerification`), taking only opaque
reference/token strings — never a raw image or document upload — matching real KYC-provider session
design (Persona/Onfido-style) and this sprint's "never store the raw government-ID image or selfie
beyond what the provider integration requires in transit" requirement. No document-upload endpoint
was built in this sprint; a caller is expected to already hold a reference from wherever the file
was captured (out of this sprint's scope).

**Payment authorization is deliberately simple for this sprint: profile-ownership only, not
business-staff-capability-aware.** `PaymentService` requires the caller to own the payer profile to
create a payment, own either the payer or recipient profile to retrieve/cancel, and own the
recipient profile specifically to refund. Finer-grained business-staff payment permissions (Sprint
4's capability model extended into payments) are out of this sprint's "provider abstraction and
sandbox architecture" scope and are a reasonable Sprint 10+ follow-up once real money movement and
the ledger exist.

**Seven new routes, no new UI** (`docs/sprints/SPRINT_09_PaymentProviderAbstraction _Sandbox.md` has
no "UI" bullet, matching Sprint 4/6/7/8's precedent): `POST /api/payments/create`,
`GET /api/payments/detail`, `POST /api/payments/cancel`, `POST /api/payments/refund`,
`POST /api/payments/webhook` (unauthenticated, signature-gated), `POST /api/kyc/submit`,
`POST /api/kyc/webhook` (unauthenticated, signature-gated). `createRecipientAccount`,
`linkBankAccount`, and `createPaymentMethodToken` are fully implemented and tested at the
`PaymentProvider`/`PaymentService` level but have no dedicated route yet — no onboarding/payment-method
UI flow consumes them in this sprint, so exposing routes for them now would be unreachable surface
area; the interface methods exist and are ready for whichever future sprint builds that flow.

**A payment attempt's status model is intentionally smaller than `docs/PAYMENT_STATE_MACHINE.md`'s
full processor-integration lifecycle** — `pending → succeeded/failed/canceled`, plus
`succeeded → refunded/disputed` — omitting `submitted`/`processing`/`cleared`/`payout_pending`/
`paid_out`/`returned`, which depend on a real processor adapter and the ledger (Sprint 10+) this
sprint does not build. `payment_attempt.agreement_id` is nullable for the same reason: this sprint's
abstraction is not yet required to be called only from an agreement-installment context.

**Known limitation: a KYC/KYB submission that creates Sprint 3's pending record but then fails at
the provider-call step leaves that profile stuck at `FULL_PENDING` with no `provider_ref`
attached.** No automated resubmission/cleanup job exists yet; recovering requires a manual
resubmission or an administrator decision, same as any other stuck-pending case. Flagged here rather
than silently assumed handled.

### Sprint 8 implementation notes

**The business financial dashboard is a new, separate route, not an extension of Sprint 3's
stub.** `/api/dashboard/business/route.test.ts` asserts an exact-match (`toEqual`) empty-state
response body; adding fields to that route would have broken that test for no real benefit. Sprint
8's real-data dashboard lives at `GET /api/b2b/dashboard?businessProfileId=` instead
(`src/lib/b2b/drizzleB2BDashboardReader.ts`), reusing the same ownership-verification discipline
(`ProfileAccessService.resolveActiveProfile`) without touching Sprint 3's file at all — mirroring
Sprint 5's own precedent of building `/agreements` as a separate surface rather than modifying that
same stub.

**Accounts Receivable/Payable reflect `current_principal_minor_units` as recorded at signing, not
a live running balance.** No payment-tracking table exists yet (Sprint 9+), so these figures cannot
reflect payments already made after signing — this is a disclosed, honest limitation ("No fake
financial data," Sprint 3's own precedent for this dashboard family), not a silent inaccuracy.
Settlements and Disputes are honestly empty arrays (Sprint 15/16 don't exist yet).

**"Authorized signers, titles, signing authority" are not re-implemented.** Sprint 6's
`signature_event.signer_title`/`signing_authority` already capture this per-signature; a new
integration test (`b2bWorkflowService.test.ts`'s "signer authority" describe block) proves a fully
signed B2B agreement — both sides genuine, verified businesses, unlike Sprint 6's own B2C-shaped
test fixture — correctly attributes `signingAuthority: "account_owner"` to both signers, without
`B2BWorkflowService` or `AgreementService` needing any change.

**"Legal entities" are not duplicated either** — `business_profile.legal_business_name` (Sprint 3)
already is the legal-entity record; Sprint 8 only adds the one genuinely new piece: structured,
repeatable invoice/PO/contract reference numbers (`agreement_reference`), since one agreement can
reference more than one.

**CSV import cannot create a draft for a customer with no existing account, and says so
explicitly.** This project has no invitation/account-creation-by-email system yet (that would be
Sprint 17's scope). A row whose `customerEmail` matches no `user_account` is left un-drafted with an
explanatory validation note ("No matching account found for this email — a draft could not be
created yet") rather than silently skipped or given a fabricated invitation flow. This is a real,
disclosed scope boundary, not a bug.

**"Never bulk activate" is structural, not just tested.** `CsvImportService`
(`src/lib/csvImport/csvImportService.ts`) has exactly one write path into the agreement system —
`AgreementService.createDraft`, whose result always starts at `draft` status — and no method that
submits, acknowledges, accepts, or signs anything. Proven both structurally (reflecting the class's
own method list finds nothing matching) and behaviorally (a created row's agreement is asserted
`draft`-status immediately after `createDrafts` returns).

**Duplicate detection runs two independent checks in one pass**: within the same file (same
customer email + invoice reference appearing twice) and against existing agreements (a non-closed
agreement already exists between this business as creditor and a debtor account matching that
email). Both are exercised by dedicated tests.

**CSV parsing is a small, dependency-free, RFC-4180-ish parser** (`src/lib/csvImport/csvParser.ts`)
— quoted fields, embedded commas, escaped `""`, CRLF/LF — sufficient for a typical spreadsheet
export; no new npm dependency was added for this.

**No UI was built.** `docs/sprints/SPRINT_08_Workflows_CSVImports.md` has no "UI" bullet in its
required-work list, matching Sprint 4's, Sprint 6's, and Sprint 7's own precedent.

**Tenant isolation** is enforced the same way as every other business-scoped action in this project
(Sprint 4/5's precedent): owner-first via `ProfileOwnerReader`, else `StaffService.
requireCapability(..., "create_agreement")` — a small, intentional amount of duplicated logic
inside `CsvImportService` rather than a forced reuse of `AgreementService`'s own two-party
`authorizeParty`, since CSV import is fundamentally a single-business action, not a two-party
agreement action.

### Sprint 7 implementation notes

**Sensitive identity/banking documents are structurally excluded, not just policy-excluded.**
`evidence_document_type` has no identity/banking vocabulary at all, and `EvidenceService`
(`src/lib/evidence/evidenceService.ts`) has no dependency capable of reading or writing
`identity_verification_record` or any bank-linking table — "Sensitive identity and banking records
must not use ordinary agreement evidence access" is enforced by what this class *can* touch, not by
a runtime check that could have a bug in it. Those records remain Sprint 3's Verification Service's
own restricted path, unchanged.

**Witnesses have zero standing in `AgreementService`, by construction.** A witness is never added
to `agreement_party` — `WitnessService` (`src/lib/evidence/witnessService.ts`) has no method that
amends terms, moves funds, or approves a settlement, because those capabilities don't exist
anywhere in this class at all. Proven both structurally (reflecting the class's own method list)
and behaviorally (a witness's user id rejected by every one of `AgreementService`'s mutating
methods) in `witnessService.test.ts`.

**A witness's read access is its own separate authorization gate, not a weakening of
`AgreementService`.** `WitnessService.getWitnessView` never calls `AgreementService.getAgreement`
(which only ever authorizes an actual party and would reject a witness) — it reads the same
underlying `AgreementRepository`/`AgreementVersionRepository`/`InstallmentScheduleItemRepository`
directly, read-only, gated solely by membership in `agreement_witness`. `AgreementService` itself
was not modified for Sprint 7.

**Witness eligibility**: must be `FULL_VERIFIED` (Sprint 3's `isFullyVerified`), must not be either
party's profile owner, must not be the acting party themselves, capped at two per agreement, no
duplicates. **Known limitation**: eligibility does not check whether the candidate is a *staff
member* of either business party (only profile-owner overlap is checked) — a business's own staff
could theoretically be added as a witness for that business's own agreement. Flagged here rather
than silently assumed handled; narrowing this further is a reasonable follow-up if it matters in
practice.

**Post-signing labeling is frozen at upload time, never a live-derived value.**
`evidence_document.is_post_signing` is set once, from whether the agreement's current version was
already signed at the moment of upload, and is never recomputed afterward — so it can never
silently drift as the agreement's status changes later (the sprint's "must never appear to have
existed before signature").

**Malware/file-validation abstraction is exactly that — an abstraction, not a real AV
integration.** `BasicFileValidator` (`src/lib/evidence/fileValidator.ts`) performs synchronous
size-cap, extension/content-type-allowlist, and magic-byte checks only; no external virus-scanning
provider is integrated in this environment (docs/ARCHITECTURE.md already lists one as an
unintegrated dependency). Every stored row's `file_validation_status` is written as `"clean"`
directly — `"pending"`/`"rejected"` exist in the enum for a future real, asynchronous AV pipeline
but are never actually written by this sprint's code (a rejection blocks storage entirely instead).

**Evidence storage reuses Sprint 6's `DocumentStorage` abstraction in a second, separate private
bucket** (`agreement-evidence`, vs. Sprint 6's `agreement-pdfs`). This required one minimal,
behavior-preserving touch to Sprint 6's `SupabaseDocumentStorage`: the bucket name moved from a
hard-coded module constant to a constructor parameter, with the single existing call site
(`getDocumentStorage.ts`) updated in the same commit to pass the same constant it always used — a
compile-time-enforced, zero-behavior-change refactor. Like Sprint 6's PDF bucket, evidence storage
is not exercised against a live Supabase project in this session (no credentials configured); the
required tests (file type restrictions, oversized/malicious handling, document ownership) are
satisfied against the shared `InMemoryDocumentStorage` fake.

**No UI was built.** `docs/sprints/SPRINT_07_Evidence_Documents_Witnesses.md` has no "UI" bullet in
its required-work list, matching Sprint 4's and Sprint 6's own precedent for sprints without one.

**Evidence upload uses `multipart/form-data`** (`request.formData()`, native to Next.js Route
Handlers) rather than a base64-JSON body — the standard approach for real file uploads, and
requires no new dependency.

**"Version linkage"** (the sprint's own required-test category) refers to witness attestation being
bound to the exact `agreement_version` the witness saw — `agreement_witness.attested_version_id` is
set once, from the agreement's current version at the moment of attestation, and is never updated
again for that witness row afterward (an attestation, once made, is as immutable as a signature).

### Sprint 6A implementation notes

**Three necessary touches to Sprint 2's `authService.ts`, all additive:**
1. `UserAccountRecord` gained `platformRole`/`accountClassification` fields (new DB columns,
   default `member`/`production` — every existing and future ordinary signup is unaffected).
   `UserAccountRepository` gained `updateStatus`/`updatePlatformRole`/`updateAccountClassification`
   — new interface methods, implemented in both the Drizzle repo and the in-memory test fake.
2. `validateSession` now rejects a session whose user's `status` is not `"active"` — a suspension
   now takes effect immediately, even for a session created before the suspension, rather than only
   at the account's next login (which was already enforced). This is a genuine behavior change for
   suspended/closed accounts, and a no-op for every active account — confirmed by Sprint 2's full
   existing test suite still passing unchanged.
3. `requireSession` (and therefore every route that calls it) now also returns the caller's trusted
   `platformRole`, sourced from the same DB-backed `validateSession` call every route already made —
   no new database round trip, no new trust boundary.

**`audit_event` gained two optional columns** (`targetResourceType`/`targetResourceId`) via
`AuditEventPayload`'s two new *optional* fields — every pre-Sprint-6A call site across every prior
sprint's service is unaffected (`canonicalize()`'s `JSON.stringify` drops an `undefined`-valued key
entirely, so the hash input, and therefore the hash itself, for every existing call site is
byte-identical to before this field existed). Confirmed by `audit/hash.test.ts` and every service's
own test suite passing unchanged.

**Signed-agreement protection is structural, not just tested.** `AdminService`
(`src/lib/admin/adminService.ts`) does not import `AgreementService`, `SignatureService`, or any
repository touching `agreement`/`agreement_version`/`agreement_party`/`installment_schedule_item`/
`signature_event`/`agreement_pdf` — there is no method on the class capable of reading or writing
any of those tables, by construction. `adminService.test.ts` includes both a behavioral proof (a
user flagged `platform_owner` still gets `ForbiddenError` from `AgreementService` when not an actual
party) and a structural proof (reflecting `AdminService`'s own prototype methods and asserting none
match `/agreement|signature|pdf/i`).

**Role administration is deliberately narrower than the full sprint-planning document's "Role
Administration" section might suggest at first read.** `AdminService.changeUserRole` supports only
`member` ↔ `platform_admin` — it can never assign, remove, or touch `platform_owner` at all (any
target whose *current* role is `platform_owner` is unconditionally rejected). This eliminates the
"last owner" edge case entirely rather than needing to guard against it, and matches the sprint
text's own two named operations ("Promote eligible Member → Platform Admin. Demote Platform Admin
→ Member.") literally. Ownership changes have exactly one path: the documented, code-free
break-glass procedure in `docs/ADMIN_BREAK_GLASS_RECOVERY.md`.

**A plain Platform Admin may act on Member accounts only** — suspend, reactivate, revoke sessions,
and classification changes all reject a target whose role is `platform_admin` or `platform_owner`,
even for an admin actor. A Platform Owner may suspend/reactivate/revoke-sessions a Platform Admin,
but never another Platform Owner (extra safety rail beyond what the sprint strictly requires, since
no owner-target action is required at all).

**"View As User" is read-only by construction, not by convention.** `startImpersonation` never
issues a session token, never sets an auth cookie, and returns only an aggregated snapshot
(`AdminUserDetail`) plus a bookkeeping `impersonationSessionId` — there is no code path from an
impersonation session to acting as the target user. Bounded by an explicit start/end pair, both
audited, both requiring the admin's own fresh step-up challenge (`admin_impersonation_start`
step-up action) for start.

**Step-up (Sprint 2's `requireStepUp`) is required for:** changing a platform role
(`admin_role_change`) and starting a support view (`admin_impersonation_start`) — the two Sprint 6A
actions with genuine account-takeover-adjacent risk. Suspend/reactivate/revoke-sessions/
classification-change do not require step-up, matching Sprint 4's own precedent that step-up gates
specifically *high-risk* capabilities, not every admin action.

**Break-glass recovery is documentation only** (`docs/ADMIN_BREAK_GLASS_RECOVERY.md`) — no
in-app override route, master password, or bypass account exists anywhere in the codebase, per the
sprint's explicit prohibition. Platform-owner recovery/transfer has exactly one path: direct
database access outside the running application.

**Admin action names use this project's existing lowercase-snake-case `action`-string convention**
(`admin_user_suspended`, `admin_role_changed`, `admin_impersonation_started`, etc.) rather than the
sprint-planning document's illustrative `ALL_CAPS` names (`USER_SUSPENDED`, `ROLE_CHANGED`) — chosen
for consistency with every other action string already in `audit_event` across Sprints 1–6, not a
deviation from the requirement itself (the event *categories* required are all present).

**No "Administrative Notes" feature was built.** The full Sprint 6A planning document's
"Administrative Notes" section (a persisted troubleshooting-note feature) was not among this
session's condensed 16-item instruction list and was treated as out of scope for this pass — user
administration's "relevant audit/support information" requirement is satisfied by exposing each
user's own audit history via the dashboard's/detail view's existing audit-event data instead. Can
be added as its own scoped follow-up if the Product Owner wants it.

**No dedicated RLS policy SQL was added beyond `ENABLE ROW LEVEL SECURITY` + `REVOKE ALL FROM anon,
authenticated`** on the one new table (`admin_impersonation_session`) — identical to every other
table in this project (zero permissive policies for those roles; the application's own database
role is the only one ever granted access, provisioned outside application code). `user_account` and
`audit_event`'s existing protection (RLS on the former, role-grant-based on the latter, per
`audit.ts`'s own doc comment) were not modified.

### Sprint 6 implementation notes

**New external dependencies:** `pdf-lib` (PDF generation, pure JS, no native deps) and
`@supabase/supabase-js` (Storage client). Both added via `npm install`; `npm audit`'s 5 existing
moderate/high findings are all in the pre-existing `drizzle-kit`/`vite`/`esbuild` dev-tooling chain
and unrelated to either new package.

**Supabase Storage is code-complete but not exercised against a live bucket.** No
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are configured in this environment (confirmed: neither
key exists in `.env.local`), so `SupabaseDocumentStorage` — real, correct calls to
`@supabase/supabase-js`'s `storage.from(bucket).upload(...)`/`.createSignedUrl(...)`, `upsert:
false` for immutability, never `getPublicUrl` — has not been run against an actual Supabase
project. Both env vars are optional at the schema level so the app still starts and every unrelated
route still works with neither set; `SupabaseDocumentStorage` itself throws a clear
`ConfigurationError` only when a storage operation is actually attempted without them (same pattern
as "Auth routes fail safely with no live database", Phase 0). All required tests (PDF generated,
hash stability, document access isolation) are satisfied against `InMemoryDocumentStorage`, a
same-contract test fake — this is the same honesty pattern already used for Vercel previews
("build success confirmed via status report, not visual inspection — protected by SSO") applied to
a provider this session has no live credentials for at all. **Before this ships to a real
environment, someone with Supabase project access needs to: create a private bucket named
`agreement-pdfs` (`src/lib/documents/supabaseDocumentStorage.ts`'s `AGREEMENT_PDF_BUCKET`
constant), set the two env vars, and confirm one real upload + signed-URL round trip.**

**No UI was built.** Unlike Sprint 5, `docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md`
has no "UI" bullet in its required-work list (same precedent as Sprint 4's "Scope note: no UI built
this sprint"). The existing Sprint 5 sign button in `src/components/AgreementDetail.tsx` was
updated (not left silently broken) to state honestly that signing now requires a step-up
verification challenge that has no UI yet, rather than send a request that would always fail.

**Consent version and auth method are client-supplied, not derived server-side.** The sprint
requires capturing "consent version" and "authentication method" as evidence. This codebase has no
concept of versioned consent-text yet and `MfaService`'s step-up record doesn't track which method
(`totp`/`sms`) was used for a given completed challenge — only that a fresh one exists. `POST
/api/agreements/sign` therefore requires the caller to state both explicitly
(`authMethod: "totp"|"sms"`, `consentVersion: string`); a future UI/consent-text system would
supply real values here. This is an honest scope boundary, not a silent gap — flagged for whoever
builds the eventual signing UI.

**"Signing authority where business" reuses Sprint 4's existing `is_authorized_representative`
field** (`business_staff_member.is_authorized_representative`, defaults `false`,
FR-B2B-002) rather than inventing a new authorization concept — a business owner is always
authorized to sign (same bootstrap-gap handling as every other business authorization check in this
project); a staff member must have this flag explicitly set, not just active membership or any
particular role/capability.

**Agreement number** in the generated PDF is the agreement's UUID — this project has no
human-readable sequential agreement-numbering scheme, and inventing one (with its own concurrency/
uniqueness design) was judged out of scope for this sprint. Flagged as an open item, not silently
assumed.

**Amendment terms and payment-authorization placeholder in the PDF are boilerplate, not real
data** — no amendment has ever been made to any Sprint 5/6 agreement (amendments are Sprint 14/15's
scope; every agreement is still on version 1), and payment authorization is explicitly out of scope
this sprint per its own text ("Do not implement payment authorization yet except required schema/
interface placeholders"). The PDF states both facts plainly rather than fabricating either.
`agreement_pdf.payment_authorization_ref` is a reserved, always-`null` placeholder column for
Sprint 9+, per the sprint's "required schema/interface placeholders" instruction.

**Witness attestations** are rendered as "None recorded" in the PDF — Sprint 7 owns the
`witness_attestation` table, which does not exist yet.

### Sprint 5 gap-closure record

An initial implementation pass left the domain layer (schema, `AgreementService`, schedule math,
authorization, audit, and all 12 required test categories — 26 agreement-specific tests) complete,
but a subsequent audit against `docs/sprints/SPRINT_05_Agreement_Engine.md` found three gaps before
this sprint could be considered done:

1. **Missing API routes.** `AgreementService.creditorDecide` (accept/reject/counter) and
   `signAgreement` were implemented and tested at the service layer but had no HTTP endpoint.
   Closed by adding `POST /api/agreements/decide` and `POST /api/agreements/sign`
   (`src/app/api/agreements/decide/route.ts`, `src/app/api/agreements/sign/route.ts`).
2. **No functional UI.** The sprint requires "Build backend/API/server actions plus functional
   UI"; none existed. Closed by adding `/agreements` (list + draft-creation form) and
   `/agreements/detail?id=` (terms, schedule, and status-appropriate actions: submit, acknowledge,
   accept/reject/counter, sign) — `src/app/agreements/page.tsx`,
   `src/app/agreements/detail/page.tsx`, `src/components/AgreementsList.tsx`,
   `src/components/AgreementDetail.tsx`, `src/components/AgreementTermsFields.tsx`. Follows this
   project's existing component conventions (client components, `early-access-form`/`field`/
   `form-status` CSS classes, `useSearchParams` for the detail route rather than a dynamic path
   segment, matching `VerifyEmailStatus.tsx`'s pattern). The debtor-acknowledgment action button's
   label ("I acknowledge this obligation is owed") is the first point at which literal
   acknowledgment language is presented to the user — previously only the backend event existed.
3. **Dead-code duplication.** `src/lib/agreements/validation.ts` defined `draftTermsSchema`/
   `profileRefSchema` that nothing imported; `src/app/api/agreements/route.ts` had its own
   duplicate inline copy. Closed by having the create route import a new `createAgreementSchema`
   (built from `draftTermsSchema.extend(...)`) from `validation.ts`, and having the new decide
   route import `draftTermsSchema` directly for `counterTerms` — one definition, two consumers.

No route-level HTTP tests were added for the two new routes: this project's existing convention
for domain-service routes (`agreements/*`, `staff/*`) relies on service-layer tests rather than
HTTP-layer route tests — confirmed by checking that none of the pre-existing agreement or staff
routes have route-level tests either. No new UI component tests were added for the same reason:
`Dashboard.tsx` and `AccountDashboard.tsx`, the closest existing analogs, have none.

Counterparty selection in the create-draft form is a raw profile-ID text input, not a directory/
search feature — this project has no counterparty lookup yet (out of scope for this sprint), and
the form says so explicitly rather than faking one.

### Sprint 4 branch/CI/Vercel record

- **Branch:** `sprint-04-business-permissions`, branched from `sprint-03-profiles`'s merged tip
  (not from an earlier point on `master`) — confirmed via `git merge-base` before starting, since
  Sprint 4 depends on Sprint 3's `business_staff_member`/`custom_role` tables and
  `ProfileAccessService`.
- **Commit:** `89c48c8` ("Implement Sprint 4: business staff permissions, RBAC, and approval
  limits").
- **Pull request:** [#3](https://github.com/AbuIbee/PAY2PAY/pull/3) — opened by the user, in
  GitHub's UI, same pattern as PR #1/#2, from `sprint-04-business-permissions` into `master`. **Left
  open, not merged.**
- **GitHub CI:** **success.** Workflow run
  [31328386726](https://github.com/AbuIbee/PAY2PAY/actions/runs/31328386726) on commit `89c48c8`,
  triggered by PR #3's `pull_request` event — `status: completed`, `conclusion: success`. Verified
  via GitHub's public Actions API, not just assumed.
- **Vercel preview:** **success.** GitHub's combined-status API for commit `89c48c8` reports
  context `Vercel`, state `success`, "Deployment has completed"
  (`target_url`: `https://vercel.com/pay2-pay/pay-2-pay/3cAsYPpGWFfqTEDio6R3JvHJNsYa`). Preview URL
  is equally SSO-protected as Sprints 2–3 — build success confirmed via Vercel's status report to
  GitHub, not visual inspection.
- **No production deployment occurred:** `master` HEAD unchanged at `4a62d6d` (the Sprint 3 merge
  commit), PR #3 `state: open`, `merged: false`, `mergeable_state: clean`.

### Sprint 3 branch/CI/Vercel record

- **Branch:** `sprint-03-profiles`, branched from `sprint-02-authentication`'s merged tip (not from
  an earlier point on `master`) — confirmed via `git merge-base` before starting, since Sprint 3
  depends on Sprint 2's `user_account`/`personal_profile`/session/MFA foundation.
- **Commit:** `1ab3c46` ("Implement Sprint 3: personal & business profiles").
- **Pull request:** [#2](https://github.com/AbuIbee/PAY2PAY/pull/2) — opened (by the user, in
  GitHub's UI, same pattern as PR #1) from `sprint-03-profiles` into `master`, specifically to
  trigger the `pull_request`-scoped CI workflow. **Left open, not merged.**
- **GitHub CI:** **success.** Workflow run
  [31326343117](https://github.com/AbuIbee/PAY2PAY/actions/runs/31326343117) on commit `1ab3c46`,
  triggered by PR #2's `pull_request` event — `status: completed`, `conclusion: success`. Verified
  via GitHub's public Actions API, not just assumed.
- **Vercel preview:** **success.** GitHub's combined-status API for commit `1ab3c46` reports
  context `Vercel`, state `success`, "Deployment has completed"
  (`target_url`: `https://vercel.com/pay2-pay/pay-2-pay/Hcz8PCf6VkQcAvWix7iqVoL7TrEf`). Preview URL
  follows the same pattern as Sprint 2's
  (`https://pay-2-pay-git-sprint-03-profiles-pay2-pay.vercel.app`) and is equally SSO-protected —
  build success confirmed via Vercel's status report to GitHub, not visual inspection.
- **No production deployment occurred:** `master` HEAD unchanged at `026b371` (the Sprint 2 merge
  commit), PR #2 `state: open`, `merged: false`, and `https://paid2you.com` re-fetched directly —
  shows Sprint 2's "Sign in" header link but no "Dashboard" mention anywhere, confirming production
  is still exactly at the Sprint 2 merged state.

### Sprint 2 branch/CI/Vercel record

- **Branch:** `sprint-02-authentication` (not merged into `master`; per governance, this sprint does not merge or deploy to production).
- **Commit:** `827a851` ("Implement Sprint 2: authentication, MFA/step-up, account foundation").
- **Pull request:** [#1](https://github.com/AbuIbee/PAY2PAY/pull/1) — opened (by the user, in GitHub's UI) from `sprint-02-authentication` into `master`, specifically to trigger the `pull_request`-scoped CI workflow (pushing the branch alone does not — `.github/workflows/ci.yml` only triggers on push/PR to `main`/`master`, a pre-existing scope limitation unrelated to this sprint's code). **Left open, not merged.**
- **GitHub CI:** **success.** Workflow run [31323009535](https://github.com/AbuIbee/PAY2PAY/actions/runs/31323009535) on commit `827a851`, triggered by PR #1's `pull_request` event — `status: completed`, `conclusion: success`. Verified via GitHub's public Actions API (`GET /repos/AbuIbee/PAY2PAY/actions/runs?branch=sprint-02-authentication`), not just assumed from the local runs.
- **Vercel preview:** **success.** GitHub's combined-status API for commit `827a851` reports context `Vercel`, state `success`, description "Deployment has completed" (`target_url`:
  `https://vercel.com/pay2-pay/pay-2-pay/4WJxzunokWMCYk3CSCVVwMkVonXz`). Preview URL:
  `https://pay-2-pay-git-sprint-02-authentication-pay2-pay.vercel.app` — attempted to browse it
  directly to visually confirm the signup/login pages render, but it redirects to Vercel's SSO
  gate (`vercel.com/sso-api`), i.e. the preview is protected and requires a logged-in team member
  to view. Build success itself is confirmed by Vercel's own status report to GitHub, not by
  visual inspection.

## F. Duplication report

Not created — no duplicate primary scope was found in Revision 1 or this re-run (Section B).

## G. Structural-safety determination (re-run)

Both High-severity conflicts from Revision 1 are resolved with correctly-sequenced, backward-only
dependencies:

- **§17 Identity verification**: architecture (Sprint 3) precedes and is called by both its
  consumers (Sprint 6 for signing, Sprint 9 for payment creation). Real provider integration
  (Sprint 9) upgrades the verification mechanism without requiring changes to Sprint 3 or Sprint 6.
- **§26 MFA**: primitive (Sprint 2) precedes and is called by all three of its consumers (Sprint 4,
  Sprint 6, Sprint 15).

The Medium-severity §19 pricing gap and Low-severity §28 retention gap are also resolved (Sprint 3
and Sprints 18/20, respectively). No duplicate primary scope exists anywhere in the 20 sprints,
confirmed on re-run. The one remaining open item (Notifications sequencing, Sprint 17) is assessed
as non-blocking for the reasons given in Sequencing risk 1 — it is a documentation-clarity
recommendation, not a structural conflict: no sprint's stated requirement is currently
unsatisfiable, unlike the resolved §17/§26 conflicts where "require elevated authentication" and
"require full verification" had no implementable meaning until this repair pass gave them one.

**Final status: READY TO BEGIN SPRINT 1**

No sprint functionality (application code) was implemented in this session — only the sprint-plan
documents listed above.
