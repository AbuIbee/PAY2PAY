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
  and the pricing/account-plan architecture. Sprint 6 and Sprint 9 call `isFullyVerified`; Sprint 12
  reads the pricing model. None re-implement either.
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
                                                │                 3's pricing model)
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
| 7–20 | Not started. Sprint plan documents for 9, 15, 18, 20 were revised in the earlier repair pass; no application code has been implemented for any of them. |

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
