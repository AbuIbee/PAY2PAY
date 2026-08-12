# PAY2PAY Deliverable Progress

Tracks completion of the 15 required deliverables defined in `docs/PAY2PAY_MASTER_SPEC.md`, Section 36.
Each deliverable is treated as one phase. Work proceeds one phase at a time per `CLAUDE.md`.

| # | Deliverable | Status |
|---|---|---|
| 1 | Executive product summary | Done — `docs/deliverables/01-executive-summary.md` |
| 2 | User roles and permissions matrix | Done — `docs/deliverables/02-roles-permissions-matrix.md` |
| 3 | Complete user journeys | Done — `docs/deliverables/03-user-journeys.md` |
| 4 | Functional requirements | Done — `docs/deliverables/04-functional-requirements.md` |
| 5 | Nonfunctional requirements | Done — `docs/deliverables/05-nonfunctional-requirements.md` |
| 6 | System architecture | Done — `docs/ARCHITECTURE.md` |
| 7 | Data model | Done — `docs/DATA_MODEL.md` |
| 8 | State machines | Done — `docs/STATE_MACHINES.md` |
| 9 | Payment architecture | Done — `docs/PAYMENT_ARCHITECTURE.md` (canonical) + `docs/PAYMENT_STATE_MACHINE.md` (companion) |
| 10 | Security threat model | Done — `docs/SECURITY_MODEL.md` |
| 11 | Compliance and legal-review checklist | Done — `docs/COMPLIANCE_REVIEW_CHECKLIST.md` + `docs/RISK_REGISTER.md` |
| 12 | Product roadmap | Done — `docs/ROADMAP.md` |
| 13 | Test strategy | Done — `docs/TEST_STRATEGY.md` |
| 14 | Open decisions | Done — `docs/OPEN_DECISIONS.md` (consolidated summary + detailed log) |
| 15 | Development work breakdown | Done — `docs/IMPLEMENTATION_PLAN.md` |

**All 15 deliverables complete.** Plus: `docs/REQUIREMENTS_TRACEABILITY_MATRIX.md` (maps every
master-spec section 1–37/18A to its implementing document and requirement ID). See
`docs/OPEN_DECISIONS.md` for the 19 unresolved matters accumulated across phases, and
`docs/IMPLEMENTATION_PLAN.md`'s final section for the Phase 0 readiness determination.

## Phase 0 implementation status

Code scope for Phase 0, as directed for this repository: Next.js/TypeScript scaffolding, CI
pipeline, `user_account` / `personal_profile` / `business_profile` / `beneficial_owner` /
`business_staff_member` / `custom_role` schema, Audit Service skeleton with hash-chaining, health
check, and environment validation. **Authentication (signup/login/logout/session management) is
scoped to Phase 1**, not Phase 0 — see the note below on `docs/IMPLEMENTATION_PLAN.md`.
Full report: `docs/PHASE_0_COMPLETION_REPORT.md`.

| Check | Result |
|---|---|
| `npm run typecheck` | Pass — no errors |
| `npm run lint` | Pass — no errors |
| `npm run test` | Pass — 80/80 tests, 16 files (includes auth-related tests; see below) |
| `npm run build` | Pass — production build succeeds |
| `/api/health` (live server) | Pass — 200 OK |
| Application shell renders | Pass |
| PWA manifest (`/manifest.webmanifest`) | Pass |
| Environment validation (`src/config/env.ts`) | Pass |
| Audit hash-chaining (genesis, chain, tamper-detection) | Pass — `src/lib/audit/hash.test.ts`, `src/lib/audit/auditService.test.ts` |
| Auth routes fail safely with no live database | Pass — 500 with a generic message, no secrets or stack trace exposed |

**Net effect on the Phase 0 acceptance gate (against the intended Phase 0 scope above): passed.**
See the completion report for the full gate-by-gate determination.

**Scope correction:** Earlier in this session, basic auth (signup, login, logout, password
hashing, and session management) was implemented and tested, treating it as in-scope for Phase 0
because `docs/IMPLEMENTATION_PLAN.md`'s Phase 0 "Features" bullet and acceptance gate text
literally name it ("basic auth (password/passkey)"; "a `user_account` can be created and
authenticated"). That was an incorrect expansion of this session's Phase 0 — authentication
belongs to Phase 1. The resulting code has **not been deleted**; it remains in the repository,
untouched, flagged for review before Phase 1 begins (full file list in
`docs/PHASE_0_COMPLETION_REPORT.md` §5). `docs/IMPLEMENTATION_PLAN.md` itself has **not** been
edited to reflect this rescoping — it still describes auth as Phase 0 work, so that document and
this one are now inconsistent until someone reconciles them (not done here, since only
`docs/PROGRESS.md` and `docs/PHASE_0_COMPLETION_REPORT.md` were in scope for this correction).

## Presentation-layer phase (marketing landing page)

Scope for this phase: a responsive, presentation-only landing page for the root route (`/`),
replacing the bare Phase 0 placeholder homepage. No new functionality — no payment integration, no
auth wiring, no Phase 1 features. Purely visual/copy work on top of the existing Next.js shell.

**Files created:** none.

**Files modified:**
- `src/app/globals.css` — extended the existing design-token set (added a fluid type scale via
  `clamp()`, additional color roles for muted/accent/subtle backgrounds, spacing steps up to
  `--space-16`, a `--radius` token) and added component classes: `.button--primary` /
  `.button--secondary`, `.badge`, `.disclaimer-banner`, `.section` / `.section-heading`, `.grid`
  with `--cols-2/3/4` responsive variants, `.card` / `.card--accent`, and a numbered `.steps` list.
  All existing Phase 0 tokens, the skip-link, and the `NFR-ACC-*` accessibility rules (focus ring,
  reduced-motion, touch-target sizing) were preserved, not replaced.
- `src/app/page.tsx` — replaced the placeholder copy with a landing page: hero (headline, lede,
  a disabled "Start an agreement" CTA, and a link to an in-page how-it-works anchor), a value-
  proposition grid (four cards sourced from `docs/deliverables/01-executive-summary.md`'s Core
  Value Proposition section), a how-it-works step list (Draft → Acknowledge → Accept → Sign, per
  `docs/ROADMAP.md` Stage 1 scope), a four-card grid for the P2P/B2C/C2B/B2B relationship shapes,
  and a "What PAY2PAY is not" section drawn verbatim in substance from the executive summary's
  "What the Platform Is Not" list (lender, guarantor, fund custodian, Sharia-certification,
  debt-collector disclaimers).
- `src/app/page.test.tsx` — rewritten to assert the new hero heading renders, that the disabled CTA
  and non-live disclaimer text are present, and that the not-a-lender/fund-custodian disclaimer
  renders.

**Visual system:** Builds on the Phase 0 CSS-custom-property token system already in
`globals.css` rather than introducing a new styling approach (no CSS framework or component
library added). Palette: existing deep-green brand color (`--brand`) plus a new muted gold
`--accent` used sparingly (badge dot, card-list accent border, step-number circles) to avoid
implying a "live/active" state with the brand color alone. Type scale is fluid (`clamp()`-based)
rather than fixed breakpoint sizes, so headings scale continuously between mobile and desktop
instead of jumping at breakpoints. Layout is CSS Grid-based with two breakpoints (`40rem`/640px,
`64rem`/1024px) matching conventional mobile/tablet/desktop boundaries: single column below 640px,
two columns from 640–1023px, three or four columns at 1024px+. All existing accessibility
affordances (skip link, visible focus ring, 44px minimum touch targets, `prefers-reduced-motion`
support) are unchanged and apply to the new content.

**Verification results:**
- `npm run typecheck` — pass, no errors.
- `npm run lint` — pass, no errors.
- `npm run test` — pass, 82/82 tests across 16 files (up from 80, due to the rewritten
  `page.test.tsx` gaining a test).
- `npm run build` — pass; `/` still prerenders as static content.
- Responsive layout (mobile/tablet/desktop): **visually verified** against the running dev server
  using the Claude-in-Chrome browser extension (not connected on the first attempt this session;
  connected on retry). The extension's `resize_window` did not actually change the page's viewport
  in this environment (window stayed pinned at 1366×768 regardless of requested size — confirmed via
  `window.innerWidth`), so breakpoints were instead tested by embedding the page in a same-origin
  `<iframe>` sized to 375–400px (mobile), 768px (tablet), and ~1320px (desktop) — an iframe gets its
  own CSS viewport for media-query purposes, so this exercises the real breakpoints. Confirmed:
  single-column stacking below 640px, two-column grids from 640–1023px, and the four-across
  `.steps` grid at 1024px+, with no horizontal overflow at any width.
- **Bug found and fixed during visual verification:** `.disclaimer-banner` (`src/app/globals.css`)
  was declared `display: flex` while applied to a `<p>` containing plain text plus an inline
  `<code>` element. Flex treats each text run and the `<code>` as separate flex items instead of
  letting them wrap as normal paragraph text, which fragmented and clipped the disclaimer text badly
  at mobile width. Fixed by changing it to `display: block` (screenshot-confirmed fix); re-ran
  typecheck/lint/`page.test.tsx` after the fix, all still pass.
- No false live-functionality claims: reviewed all landing-page copy. The primary CTA is a
  disabled `<button>` labeled "Start an agreement (not yet available)"; the how-it-works section is
  explicitly labeled "Not yet available to use"; a dedicated disclaimer banner in the hero states
  "No accounts, agreements, signatures, or payments are functional yet"; the existing footer
  disclaimer ("No live agreements or payments yet") is unchanged.

**Stopped after this phase** per `CLAUDE.md` — no payment integration or other Phase 1
functionality was started.

## Sprint 1 — Public Preview / Vercel Readiness

Source: `docs/sprints/SPRINT_01_PublicPreview _VercelReadiness.md`. Executed per
`docs/SPRINT_CONTROL.md`'s governance rules: pre-implementation checklist confirmed (project root,
git status/branch, dependencies satisfied — Sprint 1 is standalone, no duplicate-sprint warning
active), Sprint 1 marked IN PROGRESS before starting, no Sprint 2 work begun.

### Files created

- `docs/ENVIRONMENT_VARIABLES.md` — classifies every env var by deployment context and
  server-only/client-safe.
- `drizzle/migrations/0000_nervous_speedball.sql` (+ `meta/0000_snapshot.json`, `meta/_journal.json`)
  — first-ever migration for this project (no prior migration existed for any Phase 0 table either);
  includes the new `early_access_leads` table plus hand-added RLS lockdown (`REVOKE ALL ... FROM
  anon, authenticated`, no permissive policy) for Supabase's PostgREST surface.
- `src/db/schema/marketing.ts` — `early_access_leads` Drizzle table, `.enableRLS()`.
- `src/lib/us-states.ts` — shared USPS state/territory code list.
- `src/lib/early-access/earlyAccessLeadRepository.ts` — repository interface.
- `src/lib/early-access/drizzleEarlyAccessLeadRepository.ts` — Postgres-backed implementation
  (upsert-by-email).
- `src/lib/early-access/getEarlyAccessLeadRepository.ts` — lazy singleton factory (mirrors
  `getAuthService.ts`).
- `src/lib/early-access/testFakes.ts` — in-memory repository double for tests.
- `src/app/api/early-access/route.ts` — `POST` handler: zod validation, per-IP rate limiting
  (5/hour), honeypot, upsert-based duplicate handling, no PII beyond the spec's allowed field list.
- `src/app/api/early-access/route.test.ts` — 9 tests.
- `src/components/EarlyAccessForm.tsx` — client component: success/validation-error/failure states,
  conditional business-name field, honeypot field, consent checkbox linking to the placeholder
  privacy/terms pages.
- `src/components/EarlyAccessForm.test.tsx` — 7 tests.
- `src/components/LegalPlaceholder.tsx` — shared shell for the four placeholder legal routes,
  explicitly marked as unfinished/not reviewed by counsel.
- `src/app/privacy/page.tsx`, `src/app/terms/page.tsx`, `src/app/accessibility/page.tsx`,
  `src/app/support/page.tsx` — footer route placeholders (item 10); no fabricated final legal text.

### Files modified

- `src/db/schema/enums.ts` — added `earlyAccessAccountTypeEnum`.
- `src/db/schema/index.ts` — export the new `marketing` schema module.
- `src/app/globals.css` — added early-access section/form styling and footer-nav link styling,
  consistent with the existing forest/gold/serif design system; no existing rule changed.
- `src/app/page.tsx` — the former static `.closing-cta` section is now the functional Early Access
  CTA (`EarlyAccessForm`), with copy stating that joining early access does not create an account.
- `src/app/page.test.tsx` — fixed a **pre-existing** test bug unrelated to this sprint (found while
  running the full suite): "shows all four relationship types" used `getByText`, which now/already
  matched multiple elements (proof strip, product-preview mockup, and the relationship cards all
  render the same tags) — changed to `getAllByText(...).length` per the same convention already
  used in `MobileNavToggle.test.tsx`.
- `src/app/layout.tsx` — footer Privacy/Terms/Support/Accessibility now link to the new routes
  (previously plain unlinked `<span>` text).
- `docs/SPRINT_CONTROL.md` — Sprint 1 status updated to COMPLETE — awaiting review.

### Tests

`npm run test`: **99/99 passing across 18 files** (up from 82/16 at the end of the presentation-layer
phase — 17 new tests added: 9 for the API route, 7 for the form component, 1 gained by the
pre-existing-bug fix above net of no removals).

### Security/verification findings

- **Duplicate-submission handling**: implemented as upsert-by-email (unique index on `email`),
  not a hard rejection — a second submission from the same address updates their details rather
  than erroring or creating a second row.
- **Honeypot**: a visually-hidden (off-screen-positioned, not `display:none`), out-of-tab-order
  `website` field. A non-empty value causes the server to report success without writing to the
  database or revealing detection.
- **RLS**: `early_access_leads` has RLS enabled with `REVOKE ALL ... FROM anon, authenticated` and
  no permissive policy for either role — the table has zero surface area through Supabase's
  PostgREST API regardless of the anon key. The application's own writes go through
  `DATABASE_URL`/`getDb()` only (never through `supabase-js` — this codebase has never used that
  SDK). **Operational requirement flagged, not verified by this session** (no live database exists
  here): the production `DATABASE_URL` must connect using a role that bypasses RLS (the Supabase
  project's owner/direct-connection role, or any `BYPASSRLS` role) — documented in
  `docs/ENVIRONMENT_VARIABLES.md`.
- **No prohibited fields**: verified by test (`route.test.ts` "never persists a bank account, SSN,
  EIN, card, or ID field even if sent") that bank account, routing number, SSN, government ID, and
  card number are never persisted even if a client sends them — the zod schema simply has no such
  field, so unknown keys are dropped before they ever reach the repository.
- **No secrets in the client bundle**: confirmed by grepping `.next/static` for the actual
  `.env.local` secret values after a production build — no match.
- **No hardcoded `localhost`**: confirmed by search across `src/` (excluding tests) — the form calls
  the relative path `/api/early-access`.
- **No filesystem dependency, no private keys, no production financial credentials**: confirmed by
  search — none exist anywhere in the codebase.
- **Vercel build compatibility**: `npm run build` succeeds; `/` and all four new legal-placeholder
  routes prerender as static content (○), confirming the landing page render path needs no
  database connection; `/api/early-access` is correctly dynamic (ƒ).
- **No false claims that real payments/agreements are live**: reviewed all new copy. The Early
  Access section explicitly states "Joining early access does not create an account"; the existing
  hero `preview-note` ("account creation, agreements, signatures, and payments are not yet enabled")
  is unchanged; the four legal placeholder pages each state they are unfinished and not
  counsel-reviewed.

### Verification commands run

`npm run typecheck` — pass. `npm run lint` — pass (fixed two `no-html-link-for-pages` violations
found along the way — internal links must use `next/link`, not `<a>`). `npm run test` — pass,
99/99. `npm run build` — pass.

### Git commit

`82b2d98` — "Complete Sprint 1 public preview and early access". Committed outside this session
(not by this assistant); verified present on `master` and its file list matches this sprint's
files exactly.

### Vercel preview/production reference

`https://paid2you.com` — fetched and confirmed live; page content (hero heading, the
"Product preview: account creation, agreements, signatures, and payments are not yet enabled."
disclaimer) matches this build verbatim.

### ChatGPT/Product Owner review

**PASS**.

### Sprint 1 completion report (summary)

All 13 required-work items and all 8 acceptance criteria in
`docs/sprints/SPRINT_01_PublicPreview _VercelReadiness.md` are satisfied: Vercel build succeeds;
the landing page renders with no financial services enabled; the early-access form works
end-to-end against the repository abstraction (verified with an in-memory double — no live
database exists in this environment, consistent with every prior phase in this project); anonymous
users cannot query lead data (RLS + zero anon/authenticated grants); no secrets appear in the
browser bundle; no false claim that real payments are available; no payment functionality was
implemented; the git working tree is ready for an approved commit (not yet committed).

One architecture decision made without a prior explicit instruction, flagged for review: the early
-access table is stored via the existing Drizzle+Postgres (`DATABASE_URL`) path rather than adding
the `supabase-js` client SDK, since this codebase has never used that SDK — "Supabase" is treated
as the Postgres hosting platform, not a required client library. See
`docs/ENVIRONMENT_VARIABLES.md`'s architecture note.

**Sprint 1 stopped here per governance rules. Sprint 2 was not started.**

## Sprint 2 — Authentication

Source: `docs/sprints/SPRINT_02_Authentication.md`. Full architecture review, design decisions,
flows, and known gaps: `docs/AUTHENTICATION.md`. Developed on branch `sprint-02-authentication`
per the sprint's GitHub CI gate section — not developed on `master`, not merged, not deployed to
production.

### Architecture review outcome (required before writing any code)

Phase 0's existing custom auth (scrypt password hashing, session tokens, audit-logged
signup/login/logout) was reviewed component-by-component and **retained and refactored**, not
replaced with Supabase Auth. Documented blocker: `user_account` is already the FK target of five
migrated tables, and every future sprint (3–20) is planned around that identity shape; adopting
Supabase Auth's separate `auth.users` table now would be an unreviewed data-model redesign with
consequences for every later sprint, not a simple library swap. Full reasoning:
`docs/AUTHENTICATION.md` §1. **Flagged for explicit Product Owner/ChatGPT review** — the largest
divergence from the sprint's literal default in this session.

### Files created (54)

Schema: `src/db/schema/auth.ts` (5 new tables: `email_verification_token`,
`password_reset_token`, `mfa_credential`, `mfa_challenge`, `step_up_verification`).
Auth/MFA logic: `src/lib/auth/{token,totp,totp.test,mfaService,mfaService.test,mfaTestFakes,
requireSession,crossAccountIsolation.test,drizzlePersonalProfileRepository,
drizzleEmailVerificationTokenRepository,drizzlePasswordResetTokenRepository,
drizzleMfaCredentialRepository,drizzleMfaChallengeRepository,drizzleStepUpVerificationRepository,
getMfaService}.ts`. Notification placeholders: `src/lib/notify/{emailSender,consoleEmailSender,
smsSender,consoleSmsSender}.ts` (console-only — no real provider; Sprint 17's scope). API routes
(+ one `route.test.ts` each): `src/app/api/auth/{verify-email,resend-verification,
password-reset/request,password-reset/confirm,mfa/totp/enroll,mfa/totp/confirm,mfa/sms/enroll,
mfa/sms/confirm,mfa/step-up/initiate,mfa/step-up/verify}/route.ts`,
`src/app/api/account/dashboard/route.ts`. UI: `src/app/{signup,login,forgot-password,
reset-password,verify-email,account}/page.tsx` + `src/components/{SignupForm,LoginForm,
ForgotPasswordForm,ResetPasswordForm,VerifyEmailStatus,AccountDashboard}.tsx`. Migration:
`drizzle/migrations/0001_mighty_sunfire.sql` (+ meta). Docs: `docs/AUTHENTICATION.md`.

### Files modified (23)

`src/lib/auth/authService.ts` (age-gate, personal-profile creation, account-disabled check,
last-login tracking, email verification, password reset — see `docs/AUTHENTICATION.md` §3),
`src/lib/auth/{drizzleUserAccountRepository,drizzleSessionRepository,getAuthService,testFakes}.ts`,
`src/db/schema/{identity,enums,index}.ts` (new columns, RLS on every identity table, `mfa_method`
enum), `src/config/env.ts` (`APP_URL` for email links), `src/lib/errors.ts`
(`AccountDisabledError`), `src/app/api/auth/signup/{route,route.test}.ts` (date-of-birth field),
`src/app/api/auth/{login,logout,me}/route.test.ts` (date-of-birth fixture), `src/lib/auth/
authService.test.ts`, `src/app/layout.tsx` (minimal "Sign in" header link — not a marketing
redesign), `tsconfig.json` + `eslint.config.mjs` (excluded `src-backup-before-redesign/`, a
pre-existing snapshot directory that was unexpectedly being typechecked/linted — found while
verifying this sprint, unrelated to Sprint 2's own scope but blocking a clean `npm run typecheck`),
`docs/{SPRINT_CONTROL.md,PROGRESS.md}`.

### Key decisions flagged for review

1. **Supabase Auth not adopted** — see above and `docs/AUTHENTICATION.md` §1.
2. **Passkey/WebAuthn deliberately not implemented.** TOTP (verified bit-exact against the
   published RFC 6238 test vector) and SMS fallback are fully implemented; passkey requires
   attestation/assertion signature verification, a materially different risk profile better done
   as its own reviewed unit with a vetted library. `"passkey"` is reserved in the schema enum.
   `docs/AUTHENTICATION.md` §4.
3. **Login is allowed before email verification** (common practice, not required either way by the
   sprint text) — `email_verified_at` is tracked and exposed for a later sprint to gate on if
   desired.
4. **TOTP secrets are stored in plaintext** (`mfa_credential.secret_ref`) — follows the existing,
   already-accepted Phase 0 convention for other sensitive "ref" fields (no field-level
   encryption/KMS infrastructure exists yet in this project); flagged as a pre-production
   requirement, not silently accepted. `docs/AUTHENTICATION.md` §5.
5. **No real email/SMS provider integrated** — console-logging placeholders only; standing up a
   real provider is Sprint 17's explicit scope, not Sprint 2's. `docs/AUTHENTICATION.md` §5.

### Tests

165/165 passing across 32 files (up from 129 at the start of this sprint's work — 36 net new,
after also fixing the pre-existing/unrelated `src-backup-before-redesign` typecheck-inclusion bug
found along the way). Covers every item in the sprint's required test list, including all four
cross-account isolation tests (`src/lib/auth/crossAccountIsolation.test.ts` — the "business
profile" case is explicitly N/A this sprint, since no business-profile read path exists until
Sprint 3; documented inline in that test).

### Verification commands run

`npm run lint` — pass. `npm run typecheck` — pass. `npm run test` — pass, 165/165. `npm run build`
— pass, all 15 pages + 21 API routes generated correctly.

### GitHub CI / Vercel preview

Full detail in `docs/SPRINT_CONTROL.md`'s "Sprint 2 branch/CI/Vercel record". Summary: pushing the
branch alone did not trigger CI (`.github/workflows/ci.yml` only triggers on push/PR to
`main`/`master` — a pre-existing scope limitation, not a Sprint 2 defect). The user opened
[PR #1](https://github.com/AbuIbee/PAY2PAY/pull/1) (`sprint-02-authentication` → `master`, left
open, not merged) specifically to trigger it. Both gates passed: GitHub CI run
[31323009535](https://github.com/AbuIbee/PAY2PAY/actions/runs/31323009535) —
`conclusion: success`; Vercel's own status report on commit `827a851` — `state: success`,
"Deployment has completed". The preview URL itself
(`https://pay-2-pay-git-sprint-02-authentication-pay2-pay.vercel.app`) redirects to Vercel's SSO
gate, so its content was not independently browsed — build success is confirmed via Vercel's
status report to GitHub, not visual inspection.

### Git commit

`827a851` — "Implement Sprint 2: authentication, MFA/step-up, account foundation", on branch
`sprint-02-authentication`. Not merged into `master`.

### ChatGPT/Product Owner review

**PASS** (upgraded from initial CONDITIONAL PASS once `docs/AUTH_ARCHITECTURE_DECISION.md`
satisfied the review's architecture condition). Recorded retroactively here — the review outcome
itself is `docs/SPRINT_CONTROL.md`'s canonical record; this line was not updated in step at the
time to keep that turn's diff scoped to `docs/SPRINT_CONTROL.md` and the new architecture-decision
document, per instruction.

## Sprint 3 — Personal & Business Profiles

Source: `docs/sprints/SPRINT_03_Personal_Business_Profiles.md`. Developed on branch
`sprint-03-profiles`, branched from `sprint-02-authentication`'s merged tip (confirmed via
`git merge-base` before starting — Sprint 3 depends on Sprint 2's `user_account`/
`personal_profile`/session/MFA foundation, which is why this branch is based on that merged state,
not directly on an earlier point).

### Scope delivered

- **Personal profile**: unchanged shape from Phase 0/Sprint 2 (one per user, created at signup);
  its Phase 0 `verification_tier` column is removed in favor of the new verification architecture
  below.
- **Business profile**: extended with the required field set — `display_name`, `country`, `state`,
  and a `status` lifecycle (`active`/`disabled`/`deleted`) — and business creation is now a real,
  authenticated, validated flow (`POST /api/profiles/business`), not just a schema with no write
  path.
- **Identity verification architecture** (`docs/DATA_MODEL.md` §4's illustrative
  `identity_verification_record` shape): a per-attempt, insert-and-decide table — not a mutable
  column on the profile tables — so "verification status cannot self-report as FULL_VERIFIED" is
  structural (there is no column to flip). `isFullyVerified(profileKind, profileId)` is the gating
  interface Sprint 6/9–12 depend on. BASIC tier is derived from Sprint 2's
  `user_account.email_verified_at` — flagged limitation: the master spec's BASIC tier also names
  "verified phone number," which this codebase has no flow for yet, so BASIC is currently
  email-only. FULL tier only ever reaches `verified`/`rejected` through
  `VerificationService.recordManualVerificationDecision`, which also refuses to let a profile's own
  owner record their own decision. No HTTP route exposes that decision method yet — deliberately:
  exposing it without an admin-authorization system (Sprint 18) would create a real self-verification
  hole, which not exposing it avoids entirely.
- **Pricing/account-plan architecture** (master spec §19): a `pricing_plan` catalog (kept empty by
  this migration — no seed data, since "do not hard-code speculative prices" applies to seed rows
  too, not just application code) plus a `subscription` linkage table. Free-tier allowance fields
  are counts (`free_agreement_allowance`, `free_included_payments_allowance`), never a currency
  amount. `PricingService` has no method that reads or mutates an agreement — structurally, not
  just by convention (tested).
- **Profile switcher**: `ProfileAccessService.resolveActiveProfile` is the single seam every
  profile-scoped action goes through — never trusts a browser-supplied `businessProfileId` without
  re-checking ownership and `status = 'active'`. The active-profile cookie
  (`p2p_active_profile`) is a convenience hint only; `GET /api/profiles/active` re-resolves it
  through the same ownership check on every read, so a business disabled after the cookie was set
  falls back to the personal profile rather than staying selected.
- **Dashboards**: `GET /api/dashboard/personal` and `GET /api/dashboard/business` return real
  empty states (all zeros/empty arrays) — no agreement/payment/customer tables exist yet
  (Sprint 5+/9+), so nothing is fabricated.
- **UI**: business-profile creation form, profile switcher, and a combined `/dashboard` page
  (restrained styling, matching Sprint 2's established pattern — no marketing-page changes).

### Files created (≈35) / modified (≈4)

Schema: `src/db/schema/{verification,pricing}.ts` (new), `src/db/schema/{identity,enums,index}.ts`
(modified — new columns/enums, `verification_tier` removed). Services + Drizzle repos + test
fakes: `src/lib/profiles/*` (verification, business-profile, profile-access), `src/lib/pricing/*`.
API routes (+ one `route.test.ts` each): `src/app/api/profiles/{business,active}/route.ts`,
`src/app/api/profiles/route.ts`, `src/app/api/dashboard/{personal,business}/route.ts`. UI:
`src/app/dashboard/page.tsx`, `src/components/{ProfileSwitcher,BusinessProfileForm,Dashboard}.tsx`;
`src/components/AccountDashboard.tsx` gained a "Go to dashboard" link. `src/lib/errors.ts` gained
`ForbiddenError` (403 — authenticated but not authorized, distinct from `AuthenticationError`).
Migrations: `drizzle/migrations/0002_natural_thor_girl.sql` (new tables/columns),
`drizzle/migrations/0003_awesome_obadiah_stane.sql` (drops the now-superseded `verification_tier`
columns) — generated as two passes specifically to avoid `drizzle-kit`'s interactive
rename-vs-drop/add disambiguation prompt, which can't be answered non-interactively in this
environment; the two-migration split has no effect on the resulting schema versus a single
migration would have.

### Known gap flagged deliberately

`business_profile.display_name` and `.state` are added as `NOT NULL` with no default
(`0002_natural_thor_girl.sql`). This is safe to apply in every environment this project has run in
so far (no live database exists yet, consistent with every prior phase — the table has always been
empty), but would fail if ever applied against a database that already has `business_profile` rows
without a default/backfill strategy. Flagged rather than silently assumed safe forever.

### Tests

221/221 passing across 42 files (up from 165/32 at the end of Sprint 2 — 56 net new). Covers all
11 items in the sprint's required test list, including the two not already covered as a side
effect of another test ("one personal profile maximum," added as a `ConflictError` guard in
`InMemoryPersonalProfileRepository` mirroring the real schema's `UNIQUE` constraint; "cross-business
isolation," `src/lib/profiles/profileInvariants.test.ts`).

### Verification commands run

`npm run lint` — pass. `npm run typecheck` — pass. `npm run test` — pass, 221/221. `npm run build`
— pass, all 16 pages + 24 API routes generated correctly.

### Git commit

`1ab3c46` — "Implement Sprint 3: personal & business profiles", on branch `sprint-03-profiles`
(branched from `sprint-02-authentication`'s merged tip). Not merged into `master`.

### GitHub CI / Vercel preview

Full detail in `docs/SPRINT_CONTROL.md`'s Sprint 3 record. Summary: the user opened
[PR #2](https://github.com/AbuIbee/PAY2PAY/pull/2) (`sprint-03-profiles` → `master`, left open, not
merged) to trigger CI, same pattern as Sprint 2. Both gates passed: GitHub CI run
[31326343117](https://github.com/AbuIbee/PAY2PAY/actions/runs/31326343117) —
`conclusion: success`; Vercel's status report on commit `1ab3c46` — `state: success`. No production
deployment occurred: `master` unchanged at `026b371`, PR #2 unmerged, and `https://paid2you.com`
re-fetched directly shows only Sprint 2's state (no "Dashboard" mention).

### ChatGPT/Product Owner review

**PASS.**

## Sprint 4 — Business Staff Permissions

Source: `docs/sprints/SPRINT_04_BusinessStaff_Permissions.md`. Developed on branch
`sprint-04-business-permissions`, branched from `sprint-03-profiles`'s merged tip (confirmed via
`git merge-base` before starting — Sprint 4 depends on Sprint 3's `business_staff_member`/
`custom_role` tables and `ProfileAccessService`, per `docs/SPRINT_CONTROL.md`'s dependency graph).

### Scope delivered

- **Capability model** (`src/lib/staff/capabilities.ts`): the exact 13-capability list from the
  sprint text (`create_agreement` … `approve_high_value_action`). Every authorization check goes
  through `StaffService.hasCapability`/`requireCapability` — never a bare `role === "manager"`
  comparison — per "Do not use role names alone as authorization." `DEFAULT_ROLE_CAPABILITIES`
  covers `manager`/`receivables_staff`/`accountant_viewer`; `owner` always has every capability;
  `custom` has only what its own `custom_role.permissions` row grants. `HIGH_RISK_CAPABILITIES`
  (`approve_settlement`, `forgive_principal`, `manage_staff`, `change_payout_configuration`,
  `approve_high_value_action`) drives the step-up requirement on high-risk staff removal.
- **Staff membership & RBAC** (`src/lib/staff/staffService.ts`): invitation (token-hash pattern,
  7-day expiry, bound to a specific email, one pending invitation per business+email), acceptance
  (rejects if the accepting account's email doesn't match the invited email), removal (immediate
  session revocation via Sprint 2's `SessionRepository.revokeAllForUser`, plus a required fresh
  step-up when the removed member holds a high-risk capability), custom-role create/edit, and
  role changes — with a self-promotion guard (no staff member, including an owner, can change their
  own role) and a privilege-escalation guard (only an existing owner can grant the `owner` role,
  whether via invitation or a role change).
- **Approval limits** (`src/lib/staff/approvalService.ts`): `business_approval_policy` (one row per
  business+capability: an optional minor-units threshold, `requiresDualApproval`, `requiresOwner`)
  gates `proposeAction`/`decideAction` on top of — never instead of — the plain capability check.
  "Two-person approval" falls directly out of `staff_approval_request`'s shape: one proposer, one
  *different* approver, enforced both by a DB `CHECK` constraint and by `decideAction`'s own
  no-self-approval check. `requiresOwner` further restricts who may decide to staff with the `owner`
  role.
- **High-risk step-up hooks**: per the sprint's explicit list, `requireStepUp` (Sprint 2's
  primitive, unmodified — no second/competing MFA mechanism was built) is called before staff role
  changes, custom-role create/edit, approval-policy changes, and high-risk staff removal.
- **RLS**: all three new tables (`business_staff_invitation`, `business_approval_policy`,
  `staff_approval_request`) have `.enableRLS()` plus `REVOKE ALL ... FROM anon, authenticated` in
  the migration, matching every prior sprint's defense-in-depth pattern.
- **API routes**: `src/app/api/staff/{route,invite,accept-invitation,remove,role}.ts`,
  `src/app/api/staff/custom-roles/{route,update/route}.ts`,
  `src/app/api/staff/approval-policy/route.ts`,
  `src/app/api/staff/approval-requests/{route,decide/route}.ts` — every route requires a session
  (`requireSession`) and delegates authorization entirely to `StaffService`/`ApprovalService`;
  no route re-implements a capability or ownership check itself.
- **Payments**: deliberately not implemented — no payment-execution code was added or touched,
  per the sprint's explicit "Do not implement payments yet."

### Files created (27)

Schema: `src/db/schema/staff.ts` (`business_staff_invitation`, `business_approval_policy`,
`staff_approval_request` — `business_staff_member`/`custom_role` already existed from Phase 0).
Services + interfaces: `src/lib/staff/{capabilities,staffService,approvalService}.ts`. Drizzle
repositories: `src/lib/staff/drizzle{BusinessStaffMemberRepository,CustomRoleRepository,
StaffInvitationRepository,BusinessApprovalPolicyRepository,StaffApprovalRequestRepository,
UserEmailReader}.ts`. Lazy-singleton factories: `src/lib/staff/get{StaffService,
ApprovalService}.ts`. Test fakes + tests: `src/lib/staff/testFakes.ts`,
`src/lib/staff/{staffService,approvalService}.test.ts`. API routes:
`src/app/api/staff/{route,invite/route,accept-invitation/route,remove/route,role/route,
custom-roles/route,custom-roles/update/route,approval-policy/route,approval-requests/route,
approval-requests/decide/route}.ts`. Migration: `drizzle/migrations/0004_smiling_shiver_man.sql`
(+ `meta/0004_snapshot.json`).

### Files modified (3)

`src/db/schema/enums.ts` (added `approvalRequestStatusEnum`, `staffInvitationStatusEnum`),
`src/db/schema/index.ts` (export the new `staff` schema module), `drizzle/migrations/meta/
_journal.json` (drizzle-kit's own migration index).

### Scope note: no UI built this sprint

Unlike Sprints 2/3, `docs/sprints/SPRINT_04_BusinessStaff_Permissions.md` does not include a "UI"
bullet in its required-work list (only "Update docs"). No staff-management UI was built —
API routes only. Flagged here rather than silently assumed out of scope by omission.

### Tests

243/243 passing across 44 files (up from 221/42 at the end of Sprint 3 — 22 net new:
`staffService.test.ts` covers owner permissions, manager permissions, viewer denial, custom
permission, privilege escalation attempt (both at invitation time and at role-change time), staff
self-promotion attempt, removed staff (including the high-risk step-up gate), cross-business
access, invitation acceptance/email-mismatch/expiration, and duplicate-invitation rejection.
`approvalService.test.ts` covers threshold enforcement (under/over), dual approval (self-approval
rejected; a different staff member approves), owner-required thresholds, and approval-policy
step-up gating. All 10 of the sprint's named required-test scenarios are covered.

### Verification commands run

`npm run lint` — pass, no errors. `npm run typecheck` — pass, no errors. `npm run test` — pass,
243/243. `npm run build` — pass; all 11 new `/api/staff/*` routes generated correctly as dynamic
(ƒ) routes, no change to any existing static/dynamic route classification.

### Git commit

`89c48c8` — "Implement Sprint 4: business staff permissions, RBAC, and approval limits", on branch
`sprint-04-business-permissions` (branched from `sprint-03-profiles`'s merged tip). Not merged into
`master`.

### GitHub CI / Vercel preview

Full detail in `docs/SPRINT_CONTROL.md`'s Sprint 4 record. Summary: the user opened
[PR #3](https://github.com/AbuIbee/PAY2PAY/pull/3) (`sprint-04-business-permissions` → `master`,
left open, not merged) to trigger CI, same pattern as Sprints 2–3. Both gates passed: GitHub CI run
[31328386726](https://github.com/AbuIbee/PAY2PAY/actions/runs/31328386726) — `conclusion: success`;
Vercel's status report on commit `89c48c8` — `state: success`. No production deployment occurred:
`master` unchanged at `4a62d6d` (the Sprint 3 merge commit), PR #3 unmerged.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 5 — Agreement Engine

Source: `docs/sprints/SPRINT_05_Agreement_Engine.md`. Developed on branch
`sprint-05-agreement-engine`, branched from `sprint-04-business-permissions`'s tip (`2a94c6e`, the
Sprint 4 merge commit — Sprint 5 does not depend on Sprint 4's staff/RBAC tables directly, but
`AgreementService`'s business-side authorization does call `StaffService.requireCapability`/
`requireActiveStaff`, per `docs/SPRINT_CONTROL.md`'s dependency graph).

### Scope delivered

- **Agreement engine domain model** (`src/db/schema/agreement.ts`): `agreement`,
  `agreement_version`, `agreement_party`, `installment_schedule_item` — matches
  `docs/DATA_MODEL.md` §4's illustrative shapes, narrowed to this sprint's scope (no
  `signature_event`/`witness_attestation`/retention fields — those are Sprint 6/7/18/20's scope).
  All four tables have `.enableRLS()` plus `REVOKE ALL ... FROM anon, authenticated`, matching
  every prior sprint's defense-in-depth pattern.
- **All 20 required agreement fields** (category, description, original amount, previous
  payments, current principal, currency, creditor, debtor, first payment, installment amount,
  frequency, schedule, final payment, fee allocation, early payoff terms, hardship rules, partial
  payment rules, settlement rules, dispute procedure, supporting evidence references) — present
  across the schema and `AgreementTerms`.
- **Schedule calculation** (`src/lib/agreements/schedule.ts`): integer-minor-units throughout
  (FR-MONEY-001), deterministic date math with no floating-point/timezone ambiguity, and the
  rounding remainder absorbed entirely into the final installment rather than spread or dropped.
- **Full 14-state lifecycle** (`agreementStatusEnum`/`AgreementStatus`), exact spec vocabulary,
  with invalid transitions blocked by `requireStatus()`.
- **Agreement versioning + immutability**: signed versions can never be updated in place
  (`updateTerms` is only ever called pre-signature); Sprint 5 itself only ever creates version 1
  (amendments are Sprint 14/15's scope) — the versioning infrastructure exists and is exercised,
  but a second version is never created in this sprint, by design.
- **Full lifecycle service** (`src/lib/agreements/agreementService.ts`): draft creation (either
  party may initiate), debtor acknowledgment, creditor accept/reject/counter, minimal
  version-scoped signing (auto-advances to `first_payment_pending` once both parties have signed —
  no payment is initiated), audit events on every transition, and authorization that reuses
  Sprint 3's `ProfileOwnerReader` and Sprint 4's `StaffService` rather than re-implementing either.
- **API routes** (`src/app/api/agreements/`): `route.ts` (create/list), `detail/route.ts`,
  `submit/route.ts`, `acknowledge/route.ts`, `decide/route.ts`, `sign/route.ts` — all six actions
  the service supports are now reachable over HTTP.
- **Functional UI** (`src/app/agreements/`, `src/components/Agreement*.tsx`): `/agreements` (list
  the active profile's agreements; draft-creation form), `/agreements/detail?id=` (terms,
  computed schedule, and status-appropriate actions — submit, acknowledge, accept/reject/counter,
  sign). Follows this project's existing conventions (client components, `early-access-form`/
  `field`/`form-status` CSS classes, `useSearchParams` rather than a dynamic path segment,
  matching `VerifyEmailStatus.tsx`). Money is entered in dollars and converted to integer minor
  units in the browser before ever reaching the API. Counterparty selection is a raw profile-ID
  input, not a directory/search feature — none exists yet in this project (out of scope for this
  sprint), and the form states that plainly.
- **Payments**: deliberately not implemented — the lifecycle stops advancing itself at
  `first_payment_pending`; no payment-processing code was added, per the sprint's explicit
  "Do not integrate live payments."

### Two-pass process note

A first implementation pass left the domain layer (schema, service, schedule math, authorization,
audit, all 12 required test categories) complete but was found incomplete on audit: the
creditor-decide and sign actions had no API route, no UI existed at all, and
`src/lib/agreements/validation.ts` was dead code duplicated inline in `route.ts`. A second pass
closed all three gaps (see `docs/SPRINT_CONTROL.md`'s "Sprint 5 gap-closure record" for detail).
This section describes the state after both passes.

### Files created (17)

Schema: `src/db/schema/agreement.ts`. Domain logic:
`src/lib/agreements/{schedule,agreementService,validation,getAgreementService,testFakes}.ts`.
Drizzle repositories: `src/lib/agreements/drizzle{Agreement,AgreementVersion,AgreementParty,
InstallmentScheduleItem}Repository.ts`. Tests: `src/lib/agreements/{schedule,agreementService}
.test.ts`. API routes: `src/app/api/agreements/{route,detail/route,submit/route,
acknowledge/route,decide/route,sign/route}.ts`. UI:
`src/app/agreements/{page,detail/page}.tsx`, `src/components/Agreement{sList,Detail,
TermsFields}.tsx`. Migration: `drizzle/migrations/0005_slim_shadow_king.sql` (+
`meta/0005_snapshot.json`).

### Files modified (3)

`src/db/schema/enums.ts` (added `agreementStatusEnum`, `agreementPartyRoleEnum`,
`paymentFrequencyEnum`, `feeAllocationEnum`, `installmentItemStatusEnum`), `src/db/schema/index.ts`
(export the new `agreement` schema module), `drizzle/migrations/meta/_journal.json` (drizzle-kit's
own migration index).

### Tests

269/269 passing across 46 files (up from 243/44 at the end of Sprint 4 — 26 net new, all in
`src/lib/agreements/`: 18 in `agreementService.test.ts`, 8 in `schedule.test.ts`). Covers all 12
of the sprint's named required-test scenarios: P2P, B2C, B2B, debtor acknowledgment, creditor
acceptance, counter, rejection, unauthorized access, schedule arithmetic, rounding, immutable
signed record, invalid state transitions. No route-level HTTP tests or UI component tests were
added — matches this project's existing convention for domain-service routes and data-fetching
components (confirmed: none of the pre-existing `agreements/*` or `staff/*` routes have route
tests, and `Dashboard.tsx`/`AccountDashboard.tsx` have no component tests either).

### Verification commands run

`npm run typecheck` — pass, no errors. `npm run lint` — pass, no errors. `npm run test` — pass,
269/269. `npm run build` — pass; `/agreements`, `/agreements/detail`, and all six new
`/api/agreements/*` routes generated correctly, no change to any existing route's
static/dynamic classification. `npx drizzle-kit check` — pass, migration history internally
consistent, no drift.

### Git commit

**Not yet committed.** Per this session's explicit instruction, commit/push/PR is deferred until
after Product Owner review of this status entry. `git status` at the time of this report: modified
`drizzle/migrations/meta/_journal.json`, `src/db/schema/{enums,index}.ts`; untracked
`drizzle/migrations/0005_slim_shadow_king.sql`, `drizzle/migrations/meta/0005_snapshot.json`,
`src/app/agreements/`, `src/app/api/agreements/`, `src/components/Agreement{sList,Detail,
TermsFields}.tsx`, `src/db/schema/agreement.ts`, `src/lib/agreements/`. No prior sprint's files
were altered.

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push of this work beyond what was already on
`origin/sprint-05-agreement-engine` before this session, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 6 — Electronic Signatures & PDF Records

Source: `docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md`. Developed on branch
`sprint-06-ElectronicSignatures_PDFRecords`, branched from `master`'s tip (`55ae530`, the Sprint 5
merge commit — confirmed via `git merge-base --is-ancestor master sprint-06-...` before starting,
since Sprint 6 depends on Sprint 5's agreement/agreement_version tables and on Sprint 2's
`requireStepUp`/Sprint 3's `isFullyVerified` primitives, per `docs/SPRINT_CONTROL.md`'s dependency
graph).

### Scope delivered

- **Electronic-signature evidence bundle** (`src/db/schema/signature.ts`'s `signature_event`
  table): signer identity, profile/legal entity, role, business signing authority, timestamp,
  timezone, IP, device metadata, authentication method, consent version, agreement version,
  per-signature agreement hash, and the signature event's own ID — every field this sprint's text
  names. RLS + `REVOKE ALL ... FROM anon, authenticated`, matching every prior migration.
- **Elevated-authentication gates** (`src/lib/signatures/signatureService.ts`): a fresh
  `requireStepUp(user, "sign_agreement")` challenge is required immediately before any signature is
  captured; `isFullyVerified` is checked for the signer's own personal profile always, and
  additionally for the business profile when the signer is acting on a business's behalf. Either
  gate failing blocks the signature entirely — `AgreementService.signAgreement` (Sprint 5's
  unchanged state machine) is never called, and no `signature_event` row is written.
- **Business signing authority**: reuses Sprint 4's existing
  `business_staff_member.is_authorized_representative` field (FR-B2B-002) — the business owner is
  always authorized (consistent with every other business-authorization check in this project); a
  staff member must have this flag explicitly set, not just active membership.
- **Immutable PDF generation** (`src/lib/documents/agreementPdf.ts`, `pdf-lib`): agreement
  number, parties, debt purpose, financial terms, payment schedule, fees, no-interest terms,
  amendment-terms boilerplate, a payment-authorization placeholder, signatures, a witness section
  (empty — Sprint 7's scope), version, and hash/reference — every content item this sprint's text
  names. Generated exactly once per version, automatically, the moment both parties have signed
  (`agreement_pdf`'s unique index on `agreement_version_id` enforces this at the DB level too);
  never regenerated.
- **Supabase Storage abstraction** (`src/lib/documents/documentStorage.ts` +
  `supabaseDocumentStorage.ts`): private-bucket upload (`upsert: false`), signed-URL-only retrieval
  (never `getPublicUrl`), matching this sprint's "Never expose private buckets publicly." **Not
  exercised against a live Supabase project this session — no credentials configured in this
  environment.** See `docs/SPRINT_CONTROL.md`'s "Sprint 6 implementation notes" for the honest
  detail on this and every other scope boundary/design choice made this sprint (agreement-number
  format, consent-version/auth-method being client-supplied, no UI, etc.).
- **Document access isolation**: `SignatureService.getSignedPdfUrl` re-runs full party
  authorization (via `AgreementService.getAgreement`) before ever asking storage for a URL — a
  short-lived, freshly issued signed URL every call, never cached.
- **Shared document-hash extraction**: `AgreementService`'s private `computeDocumentHash` was
  moved to `src/lib/agreements/documentHash.ts` as a reusable pure function — identical algorithm
  and output, zero behavior change (Sprint 5's 26 tests all still pass unchanged), so
  `SignatureService` can compute the same per-signature hash without duplicating it.
- **`AgreementService.resolvePartyRole`**: one new public method, a thin wrapper around the
  existing private `authorizeEitherParty` — purely additive, no existing behavior touched.
- **Payments**: deliberately not implemented — only the reserved, always-`null`
  `agreement_pdf.payment_authorization_ref` placeholder column exists, per the sprint's explicit
  "Do not implement payment authorization yet except required schema/interface placeholders."

### Files created (16)

Schema: `src/db/schema/signature.ts`. Domain logic: `src/lib/agreements/documentHash.ts`,
`src/lib/signatures/{signatureService,getSignatureService,drizzleSignatureEventRepository,
drizzleAgreementPdfRepository,testFakes}.ts`, `src/lib/documents/{documentStorage,
supabaseDocumentStorage,getDocumentStorage,agreementPdf,profileDisplayReader,
drizzleProfileDisplayReader,testFakes}.ts`. Tests: `src/lib/signatures/signatureService.test.ts`
(13 tests). API route: `src/app/api/agreements/pdf/route.ts`. Migration:
`drizzle/migrations/0006_last_otto_octavius.sql` (+ `meta/0006_snapshot.json`).

### Files modified (9)

`src/app/api/agreements/sign/route.ts` (now calls `SignatureService.sign` instead of raw
`AgreementService.signAgreement`; request body extended with `authMethod`/`consentVersion`/
`timezone`/`deviceInfo`; IP captured server-side via `getClientIp`), `src/components/
AgreementDetail.tsx` (sign button now honestly disabled with an explanation, since signing requires
a step-up-challenge UI that doesn't exist yet — was not left silently broken by the new required
fields), `src/config/env.ts` (added optional `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`),
`src/db/schema/{enums,index}.ts` (added `signingAuthorityEnum`, exported the new `signature`
module), `src/lib/agreements/agreementService.ts` (extracted hash function, added
`resolvePartyRole` — both additive/non-breaking, confirmed by Sprint 5's full test suite still
passing), `src/lib/staff/testFakes.ts` (`seed()` gained an optional `isAuthorizedRepresentative`
parameter, default `false` — backward-compatible with every existing Sprint 4/5 call site),
`drizzle/migrations/meta/_journal.json`, `package.json`/`package-lock.json` (added `pdf-lib` and
`@supabase/supabase-js`).

### Tests

282/282 passing across 47 files (up from 269/46 at the end of Sprint 5 — 13 net new, all in
`src/lib/signatures/signatureService.test.ts`). Covers all 11 of the sprint's named required-test
scenarios: signature authorization, second-party signature, unauthorized signer, signing blocked
without a passed step-up challenge, signing blocked when signer profile is not `FULL_VERIFIED`,
signing blocked when business profile is not `FULL_VERIFIED`, business signer authority (owner,
non-authorized staff rejected, authorized staff accepted), PDF generated, document access
isolation, hash stability, and signed agreement cannot be edited. Sprint 5's own 26 tests (and
every other prior sprint's tests) all still pass unchanged.

### Verification commands run

`npm run typecheck` — pass, no errors. `npm run lint` — pass, no errors. `npm run test` — pass,
282/282. `npm run build` — pass; `/api/agreements/pdf` generated correctly as a new dynamic route,
`/api/agreements/sign` unchanged in classification, no change to any other route. `npx drizzle-kit
check` — pass, migration history internally consistent, no drift.

### Git commit

**Not yet committed.** Per this session's explicit instruction, commit/push/PR is deferred until
after Product Owner review of this status entry. `git status` at the time of this report: modified
`drizzle/migrations/meta/_journal.json`, `package.json`, `package-lock.json`,
`src/app/api/agreements/sign/route.ts`, `src/components/AgreementDetail.tsx`, `src/config/env.ts`,
`src/db/schema/{enums,index}.ts`, `src/lib/agreements/agreementService.ts`,
`src/lib/staff/testFakes.ts`; untracked `drizzle/migrations/0006_last_otto_octavius.sql`,
`drizzle/migrations/meta/0006_snapshot.json`, `src/app/api/agreements/pdf/`,
`src/db/schema/signature.ts`, `src/lib/agreements/documentHash.ts`, `src/lib/documents/`,
`src/lib/signatures/`. No file outside this list was touched; no prior sprint's behavior changed
beyond the two additive AgreementService touches noted above.

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 6A — Platform Administration & Audit Control

Source: `docs/sprints/SPRINT_06A_Platform_Administration_Audit_Control.md`. Developed on branch
`sprint-06A-platform-administration`, branched from `master`'s tip (`72ae5b4`, the Sprint 6 merge
commit).

### Scope delivered

- **Three-tier platform-role model** (`member`/`platform_admin`/`platform_owner`,
  `src/lib/admin/capabilities.ts`): trusted only from the `user_account.platform_role` DB column,
  threaded through the existing `requireSession` seam — never derived from client-supplied state.
- **Protected `/admin` control plane**: every `/api/admin/*` route independently re-checks the
  trusted `platformRole` from `requireSession`; the admin nav link is hidden from non-admins for UX
  only (`AdminNavLink.tsx`, via `/api/admin/whoami`) — not the security boundary. A Member hitting
  any admin route or URL directly gets 401/403, proven by a dedicated route-level test.
- **Functional admin UI** (`/admin`, `/admin/users`, `/admin/users/detail`): dashboard with
  real-data-only counts (users by status/classification, personal/business profile counts,
  agreement counts by status, signature-event/PDF counts, recent audit + admin-action events), user
  search by email/ID, and a user-detail view with businesses/agreements/status plus every admin
  action.
- **User administration**: suspend, reactivate, revoke sessions, role change (owner-only,
  step-up-gated, member↔platform_admin only), and test-account classification change — all via
  `AdminService` (`src/lib/admin/adminService.ts`), all server-side-authorized, all audited.
- **Durable test-account classification** (`account_classification`:
  production/internal/qa/demo/automated_test) — independent of `user_account.status` and of any
  naming convention.
- **Full admin audit logging**: every mutation reuses the existing `AuditService`/`audit_event`
  hash-chained trail (not a parallel system), extended with two new optional
  `targetResourceType`/`targetResourceId` columns.
- **Read-only "View As User"**: `AdminService.startImpersonation`/`endImpersonation` — never issues
  a session token for the target, bounded by an explicit audited start/end pair, step-up required
  to start.
- **Documented break-glass recovery** (`docs/ADMIN_BREAK_GLASS_RECOVERY.md`): no in-app override,
  master password, or bypass account — platform-owner recovery has exactly one path, direct
  database access outside the running application, per the sprint's explicit prohibition list.
- **Signed-agreement protection is structural**: `AdminService` never imports `AgreementService`,
  `SignatureService`, or any repository touching agreement/signature/PDF tables — there is no code
  path here that could weaken Sprint 5/6's immutability guarantees, proven both behaviorally and by
  reflecting the class's own method list in a test.

### Necessary Sprint 2 touches (all additive, zero regression)

`UserAccountRecord`/`UserAccountRepository` gained `platformRole`/`accountClassification` fields and
`updateStatus`/`updatePlatformRole`/`updateAccountClassification` methods; `validateSession` now
also rejects a non-`"active"` status (closing the gap where a session created before a suspension
would otherwise keep working until its own expiry — suspension enforcement is now immediate);
`requireSession` now also returns the trusted `platformRole`. `AuditEventPayload` gained two
*optional* fields, which is why every pre-Sprint-6A audit call site is provably unaffected (an
omitted optional key is dropped by `JSON.stringify` before hashing). Full detail in
`docs/SPRINT_CONTROL.md`'s "Sprint 6A implementation notes."

### Files created (17)

Schema: `src/db/schema/admin.ts`. Domain logic: `src/lib/admin/{capabilities,adminService,
getAdminService,drizzleAdminOverviewReader,drizzleAdminUserDirectoryReader,
drizzleAdminImpersonationSessionRepository,testFakes}.ts`. Tests:
`src/lib/admin/adminService.test.ts` (17 tests), `src/app/api/admin/overview/route.test.ts` (4
tests). API routes: `src/app/api/admin/{whoami,overview,users/route,users/detail,users/suspend,
users/reactivate,users/revoke-sessions,users/role,users/classification,impersonation/start,
impersonation/end}.ts`. UI: `src/app/admin/{page,users/page,users/detail/page}.tsx`,
`src/components/Admin{Dashboard,Users,UserDetail,NavLink}.tsx`. Doc:
`docs/ADMIN_BREAK_GLASS_RECOVERY.md`. Migration: `drizzle/migrations/0007_short_gauntlet.sql` (+
`meta/0007_snapshot.json`).

### Files modified (11)

`src/db/schema/{enums,identity,audit,index}.ts` (new enums/columns), `src/lib/audit/hash.ts` +
`drizzleAuditEventRepository.ts` (optional target-resource fields), `src/lib/auth/{authService,
drizzleUserAccountRepository,requireSession,testFakes}.ts` (see "Necessary Sprint 2 touches"),
`src/app/layout.tsx` (admin nav link), `drizzle/migrations/meta/_journal.json`.

### Tests

303/303 passing across 49 files (up from 282/47 at the end of Sprint 6 — 21 net new: 17 in
`adminService.test.ts`, 4 in the new `overview/route.test.ts`). Covers all 10 of the sprint's named
required-test scenarios: Member blocked from every admin operation, Platform Admin's authorized
functions work, Platform Admin blocked from owner-only actions, Platform Admin blocked from
touching Owner/other-Admin accounts, Platform Owner's authorized operations work (with step-up),
admin actions create audit records, unauthorized direct API access is rejected (dedicated
route-level test — the one deliberate exception to this project's usual service-layer-only test
convention, since this requirement is inherently about the HTTP layer), test-account classification
behaves correctly, immutable signed records remain protected from both admin roles (behavioral +
structural proof), and the full Sprint 1–6 suite passes unchanged.

### Verification commands run

`npm run typecheck` — pass, no errors. `npm run lint` — pass, no errors. `npm run test` — pass,
303/303. `npm run build` — pass; `/admin`, `/admin/users`, `/admin/users/detail`, and all 10 new
`/api/admin/*` routes generated correctly, no change to any existing route's classification. `npx
drizzle-kit check` — pass, migration history internally consistent, no drift.

### Git commit

**Not yet committed.** Per this session's explicit instruction, commit/push/PR is deferred until
after Product Owner review of this status entry. `git status` at the time of this report: modified
`drizzle/migrations/meta/_journal.json`, `src/app/layout.tsx`, `src/db/schema/{audit,enums,
identity,index}.ts`, `src/lib/audit/{drizzleAuditEventRepository,hash}.ts`,
`src/lib/auth/{authService,drizzleUserAccountRepository,requireSession,testFakes}.ts`; untracked
`docs/ADMIN_BREAK_GLASS_RECOVERY.md`, `drizzle/migrations/0007_short_gauntlet.sql`,
`drizzle/migrations/meta/0007_snapshot.json`, `src/app/admin/`, `src/app/api/admin/`,
`src/components/Admin{Dashboard,NavLink,UserDetail,Users}.tsx`, `src/db/schema/admin.ts`,
`src/lib/admin/`. No file outside this list was touched; no prior sprint's behavior changed beyond
the necessary, additive Sprint 2/audit touches documented above.

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 7 — Evidence, Documents & Witnesses

Source: `docs/sprints/SPRINT_07_Evidence_Documents_Witnesses.md`. Developed on branch
`sprint-07-evidence-documents-witnesses`. **This branch was stale when this session started** — it
predated the Sprint 6A merge and had zero unique commits of its own, so it was fast-forwarded to
`master`'s tip (`4356d24`, the Sprint 6A merge commit) before any Sprint 7 work began (confirmed
safe: no divergence, branch not yet pushed to origin, so no history was rewritten out from under
anyone).

### Scope delivered

- **Evidence documents** (`src/db/schema/evidence.ts`'s `evidence_document` table,
  `src/lib/evidence/evidenceService.ts`): upload with metadata/uploader/timestamp/agreement
  association, shared/private party-to-party visibility, an independent witness-sharing flag,
  dispute flag, withdrawal state (never deleted, only excluded from "active" going forward),
  malware/file-validation abstraction (`BasicFileValidator`), and secure signed-URL access —
  every item this sprint's "Implement:" list names.
- **Mandatory post-signing labeling**: `is_post_signing` is frozen at upload time from whether the
  agreement was already signed at that moment, never recomputed afterward — evidence can never
  retroactively "become" pre-signing or vice versa.
- **Witnesses** (`agreement_witness` table, `src/lib/evidence/witnessService.ts`): maximum two per
  agreement, must be `FULL_VERIFIED`, added only by an actual party, view-only access to the
  agreement (own authorization gate, entirely separate from `AgreementService`'s party-only
  authorization), and version-bound attestation ("may attest only to exact version") — a witness has
  zero standing to amend terms, receive funds, or approve a settlement, proven structurally (no such
  method exists on the class) and behaviorally (rejected by every `AgreementService` mutating
  method).
- **Sensitive identity/banking documents remain structurally excluded** — `EvidenceService` has no
  dependency capable of touching `identity_verification_record` or any bank-linking table at all.
- **Evidence storage** reuses Sprint 6's `DocumentStorage` abstraction in a second, separate private
  bucket (`agreement-evidence`) — required parametrizing `SupabaseDocumentStorage`'s bucket via its
  constructor (one minimal, compile-time-verified, zero-behavior-change touch to Sprint 6, with its
  single existing call site updated in the same commit).
- **No UI was built** — this sprint has no "UI" bullet in its required-work list, matching Sprint
  4's and Sprint 6's own precedent.

### Files created (18)

Schema: `src/db/schema/evidence.ts`. Domain logic: `src/lib/evidence/{fileValidator,
evidenceService,witnessService,witnessReaderAdapter,drizzleEvidenceRepository,
drizzleAgreementWitnessRepository,getEvidenceService,getWitnessService,getEvidenceStorage,
testFakes}.ts`. Tests: `evidenceService.test.ts` (12 tests), `witnessService.test.ts` (11 tests).
API routes: `src/app/api/agreements/evidence/{route,withdraw/route,dispute-flag/route,
signed-url/route}.ts`, `src/app/api/agreements/witnesses/{route,attest/route,view/route}.ts`.
Migration: `drizzle/migrations/0008_steep_mysterio.sql` (+ `meta/0008_snapshot.json`).

### Files modified (5)

`src/db/schema/{enums,index}.ts` (new enums, export the new schema module),
`src/lib/documents/{supabaseDocumentStorage,getDocumentStorage}.ts` (bucket-as-constructor-param
refactor, see "Scope delivered" above — zero behavior change for Sprint 6's own PDF storage, its
own tests all still pass unchanged), `drizzle/migrations/meta/_journal.json`.

### Tests

326/326 passing across 51 files (up from 303/49 at the end of Sprint 6A — 23 net new: 12 in
`evidenceService.test.ts`, 11 in `witnessService.test.ts`). Covers all 7 of the sprint's named
required-test categories: access control, post-signing labeling, witness isolation (structural +
behavioral), document ownership, file type restrictions, oversized/malicious file handling, and
version linkage. Sprint 6's own PDF-storage tests and every other prior sprint's tests all still
pass unchanged.

### Verification commands run

`npm run typecheck` — pass, no errors. `npm run lint` — pass, no errors. `npm run test` — pass,
326/326. `npm run build` — pass; 8 new `/api/agreements/{evidence,witnesses}/*` routes generated
correctly, no change to any existing route's classification. `npx drizzle-kit check` — pass,
migration history internally consistent, no drift. RLS + `REVOKE ALL ... FROM anon, authenticated`
confirmed present on both new tables (`agreement_witness`, `evidence_document`).

### Git commit

**Not yet committed.** Per this session's explicit instruction, commit/push/PR is deferred until
after Product Owner review of this status entry. `git status` at the time of this report: modified
`drizzle/migrations/meta/_journal.json`, `src/db/schema/{enums,index}.ts`,
`src/lib/documents/{getDocumentStorage,supabaseDocumentStorage}.ts`; untracked
`drizzle/migrations/0008_steep_mysterio.sql`, `drizzle/migrations/meta/0008_snapshot.json`,
`src/app/api/agreements/evidence/`, `src/app/api/agreements/witnesses/`,
`src/db/schema/evidence.ts`, `src/lib/evidence/`. No file outside this list was touched; no prior
sprint's behavior changed beyond the necessary, additive Sprint 6 storage-bucket touch documented
above.

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 8 — B2B Workflows & CSV Imports

Source: `docs/sprints/SPRINT_08_Workflows_CSVImports.md`. Developed on branch
`sprint-08-workflows-csv-imports`, branched from `master`'s tip (`261ec0e`, the Sprint 7 merge
commit; already up to date this time, unlike the two prior sprints — no fast-forward needed).

### Scope delivered

- **B2B workflow completion** (`src/lib/b2b/b2bWorkflowService.ts`): "Both parties must use
  verified business profiles" is now enforced *before* draft creation for B2B agreements — either
  side being personal, or either business not being `FULL_VERIFIED`, is rejected outright.
  "Legal entities" reuse `business_profile.legal_business_name` (Sprint 3, not duplicated);
  "authorized signers/titles/signing authority" reuse Sprint 6's `signature_event` capture (not
  duplicated — a new integration test proves it works correctly for genuine B2B, both-sides-
  business agreements, which Sprint 6's own tests never exercised). The one genuinely new piece is
  structured, repeatable invoice/PO/contract reference tracking (`agreement_reference`).
- **Business financial dashboard** (`GET /api/b2b/dashboard`): real Accounts Receivable/Payable,
  Active Agreements, Upcoming/Past-Due payments, computed directly from Sprint 5's tables.
  Settlements/Disputes stay honestly empty (Sprint 15/16 don't exist yet). Deliberately a *new*
  route — Sprint 3's `/api/dashboard/business` has an exact-match test that extending it would have
  broken, so it was left completely untouched (confirmed: its own test still passes unchanged).
- **CSV import** (`src/lib/csvImport/csvImportService.ts`): the full UPLOAD → VALIDATE → PREVIEW →
  DUPLICATE CHECK → ERROR REPORT → CREATE DRAFTS pipeline for customers/invoices/balances/proposed
  plans. Validation reuses Sprint 5's own `computeSchedule` to confirm each proposed plan is
  internally consistent, not a re-implementation of that logic. Duplicate checking covers both
  within-file and against-existing-agreement cases. **Never bulk activates**: the only write path
  into the agreement system is the unchanged `AgreementService.createDraft` (always `draft` status);
  a debtor with no existing account is left un-drafted with an explicit explanatory note rather than
  silently skipped or given an invented invitation flow (this project has no invitation system yet —
  Sprint 17's scope).
- **Dependency-free CSV parser** (`src/lib/csvImport/csvParser.ts`) — no new npm package.

### Files created (26)

Schema: `src/db/schema/{b2bWorkflow,csvImport}.ts`. B2B domain logic: `src/lib/b2b/{b2bWorkflowService,
b2bDashboardReader,drizzleB2BDashboardReader,drizzleAgreementReferenceRepository,
getB2BWorkflowService,getB2BDashboardReader,testFakes,b2bWorkflowService.test}.ts` (6 tests). CSV
import domain logic: `src/lib/csvImport/{csvParser,csvImportService,drizzleCsvImportBatchRepository,
drizzleCsvImportRowRepository,drizzleCustomerAccountResolver,drizzleExistingAgreementDuplicateChecker,
getCsvImportService,testFakes,csvImportService.test}.ts` (11 tests). API routes:
`src/app/api/b2b/{agreements/route,agreements/references/route,dashboard/route}.ts`,
`src/app/api/csv-import/{upload,validate,preview,create-drafts}/route.ts`. Migration:
`drizzle/migrations/0009_flat_barracuda.sql` (+ `meta/0009_snapshot.json`).

### Files modified (3)

`src/db/schema/{enums,index}.ts` (new enums, export the two new schema modules),
`drizzle/migrations/meta/_journal.json`. **`src/app/api/dashboard/business/route.ts` (and its test)
were deliberately left untouched** — see "Scope delivered" above.

### Tests

343/343 passing across 53 files (up from 326/51 at the end of Sprint 7 — 17 net new: 6 in
`b2bWorkflowService.test.ts`, 11 in `csvImportService.test.ts`). Covers all 7 of the sprint's named
required-test categories: B2B authorization, signer authority, import validation, duplicate
handling, invalid row, no bulk activation, and tenant isolation. Sprint 3's `/api/dashboard/business`
route test and every other prior sprint's tests all still pass unchanged.

### Verification commands run

`npm run typecheck` — pass, no errors. `npm run lint` — pass, no errors. `npm run test` — pass,
343/343. `npm run build` — pass; 7 new `/api/{b2b,csv-import}/*` routes generated correctly, no
change to any existing route's classification. `npx drizzle-kit check` — pass, migration history
internally consistent, no drift. RLS + `REVOKE ALL ... FROM anon, authenticated` confirmed present
on all three new tables (`agreement_reference`, `csv_import_batch`, `csv_import_row`).

### Git commit

**Not yet committed.** Per this session's explicit instruction, commit/push/PR is deferred until
after Product Owner review of this status entry. `git status` at the time of this report: modified
`drizzle/migrations/meta/_journal.json`, `src/db/schema/{enums,index}.ts`; untracked
`drizzle/migrations/0009_flat_barracuda.sql`, `drizzle/migrations/meta/0009_snapshot.json`,
`src/app/api/b2b/`, `src/app/api/csv-import/`, `src/db/schema/{b2bWorkflow,csvImport}.ts`,
`src/lib/b2b/`, `src/lib/csvImport/`. No file outside this list was touched; no prior sprint's
behavior changed at all this sprint (unlike Sprints 6/7, which each needed one narrow, additive
touch to a prior sprint's file — Sprint 8 needed none).

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 9 — Payment Provider Abstraction & Sandbox

Source: `docs/sprints/SPRINT_09_PaymentProviderAbstraction _Sandbox.md`. Developed on branch
`sprint-09-payment-provider-abstraction`, branched from `master`'s tip (`b5f68ed`, the Sprint 8
merge commit; already up to date, no fast-forward needed).

### Scope delivered

- **Payment-provider abstraction** (`src/lib/payments/paymentProvider.ts`): interfaces for create
  recipient/connected account, bank linking, payment-method token, create/retrieve/cancel/refund
  payment, and webhook verification, plus a deterministic `SandboxPaymentProvider`
  (`src/lib/payments/sandboxPaymentProvider.ts`) — no live processor is configured or called.
- **`PaymentService`** (`src/lib/payments/paymentService.ts`): the ONE call site that enforces
  Sprint 3's `isFullyVerified` for both payer and recipient before any payment is created, so
  neither a future provider adapter nor the Sprint 10 ledger can bypass it. Also owns outbound
  idempotency (`payment_attempt.idempotency_key`, unique, race-safe insert-then-recheck) and
  retrieve/cancel/refund authorization.
- **`PaymentWebhookService`** (`src/lib/payments/paymentWebhookService.ts`): signature verification
  → `(provider, provider_event_id)`-keyed replay/duplicate-event protection → status-transition
  processing → audit.
- **KYC/KYB provider abstraction** (`src/lib/kyc/kycProvider.ts`, `sandboxKycProvider.ts`) — a
  deliberately separate interface/adapter from the payment side. `KycVerificationService`
  (`src/lib/kyc/kycVerificationService.ts`) reuses Sprint 3's `submitFullVerificationRequest` (its
  existing "already pending" guard IS the duplicate-submission protection) and attaches the
  provider's verification id via a new `recordProviderSubmission` method.
  `KycWebhookService`(`src/lib/kyc/kycWebhookService.ts`) applies the same
  signature/replay/idempotency shape to drive Sprint 3's `FULL_PENDING → FULL_VERIFIED`/
  `FULL_REJECTED` transition via a new `recordProviderVerificationDecision` method.
  `isFullyVerified`/`getVerificationState`/`submitFullVerificationRequest`/
  `recordManualVerificationDecision` are byte-identical to before this sprint.
- **Shared webhook HMAC helper** (`src/lib/webhookSignature.ts`) — the one piece of code shared
  between the two otherwise-separate provider integrations, since it is pure cryptography, not a
  merge of the two domain interfaces.
- **Processor/KYC-provider evaluation and recommendation**: `docs/PAYMENT_ARCHITECTURE.md` §15 —
  Stripe (Connect + ACH Direct Debit + Financial Connections + debit card) recommended, Plaid
  Link/Transfer + a separate processor documented as contingency; Stripe Identity recommended if
  Stripe is selected, Persona documented as a decoupled contingency. No provider approval is
  assumed or implied; open decisions #3 and #16 remain open (`docs/OPEN_DECISIONS.md` updated).
- **Seven new routes, no UI** (this sprint's spec has no "UI" bullet): payments
  create/detail/cancel/refund/webhook, kyc submit/webhook.

### Files created (32)

Schema: `src/db/schema/{payment,kyc}.ts`. Payments domain logic: `src/lib/payments/{paymentProvider,
sandboxPaymentProvider,paymentService,drizzlePaymentAttemptRepository,paymentWebhookService,
drizzlePaymentWebhookEventRepository,getPaymentProvider,getPaymentService,getPaymentWebhookService,
testFakes,sandboxPaymentProvider.test,paymentService.test,paymentWebhookService.test}.ts` (29
tests). KYC/KYB domain logic: `src/lib/kyc/{kycProvider,sandboxKycProvider,kycVerificationService,
kycWebhookService,drizzleKycWebhookEventRepository,getKycProvider,getKycVerificationService,
getKycWebhookService,testFakes,sandboxKycProvider.test,kycVerificationService.test,
kycWebhookService.test}.ts` (15 tests). Shared: `src/lib/webhookSignature.ts`. API routes:
`src/app/api/payments/{create,detail,cancel,refund,webhook}/route.ts`,
`src/app/api/kyc/{submit,webhook}/route.ts`. Migration: `drizzle/migrations/0010_great_human_fly.sql`
(+ `meta/0010_snapshot.json`).

### Files modified (10)

`src/db/schema/{enums,index}.ts` (new `payment_attempt_status` enum, export the two new schema
modules); `src/config/env.ts` (two new optional sandbox-webhook-secret env vars);
`src/lib/profiles/verificationService.ts` (additive: `providerRef` field, widened
`IdentityVerificationRecordRepository.updateDecision`/new `attachProviderRef`/`findByProviderRef`
methods, new `recordProviderSubmission`/`recordProviderVerificationDecision` service methods) with
matching updates to `drizzleIdentityVerificationRecordRepository.ts` and `testFakes.ts`; 7 new tests
appended to `verificationService.test.ts` for the additive methods only. `drizzle/migrations/meta/
_journal.json`. `docs/{PAYMENT_ARCHITECTURE,OPEN_DECISIONS,SPRINT_CONTROL}.md`.

### Tests

394/394 passing across 65 files (up from 343/53 at the end of Sprint 8 — 51 net new: 7 in
`verificationService.test.ts`, 11 in `sandboxPaymentProvider.test.ts`, 12 in `paymentService.test.ts`,
6 in `paymentWebhookService.test.ts`, 6 in `sandboxKycProvider.test.ts`, 3 in
`kycVerificationService.test.ts`, 6 in `kycWebhookService.test.ts`). Covers every one of the
sprint's named required-test categories on both sides: provider adapter, webhook spoof, replay,
idempotency, duplicate event, processor failure, payment creation blocked when payer/recipient not
`FULL_VERIFIED` (payment side); provider adapter, webhook spoof, `FULL_PENDING → FULL_VERIFIED`,
`FULL_PENDING → FULL_REJECTED`, gated while pending/rejected, duplicate verification submission
(KYC/KYB side). Sprints 1–8's own tests all still pass unchanged.

### Verification commands run

`npx tsc --noEmit` — pass, no errors. `npx eslint .` — pass, 0 errors (6 pre-existing-pattern
warnings for intentionally-unused mock-adapter parameters, consistent with this codebase's existing
lint configuration). `npx vitest run` — pass, 394/394 across 59 files. `npx next build` — pass; all
7 new `/api/{payments,kyc}/*` routes generated correctly, no change to any existing route's
classification. `npx drizzle-kit check` — pass, migration history internally consistent, no drift.
RLS + `REVOKE ALL ... FROM anon, authenticated` confirmed present on all three new tables
(`payment_attempt`, `payment_webhook_event`, `kyc_webhook_event`).

### Git commit

**Not yet committed.** Per this session's explicit instruction, commit/push/PR is deferred until
after Product Owner review of this status entry. `git status` at the time of this report: modified
`docs/{OPEN_DECISIONS,PAYMENT_ARCHITECTURE,SPRINT_CONTROL}.md`,
`drizzle/migrations/meta/_journal.json`, `src/config/env.ts`, `src/db/schema/{enums,index}.ts`,
`src/lib/profiles/{drizzleIdentityVerificationRecordRepository,testFakes,verificationService,
verificationService.test}.ts`; untracked `drizzle/migrations/0010_great_human_fly.sql`,
`drizzle/migrations/meta/0010_snapshot.json`, `src/app/api/kyc/`, `src/app/api/payments/`,
`src/db/schema/{kyc,payment}.ts`, `src/lib/kyc/`, `src/lib/payments/`,
`src/lib/webhookSignature.ts`. No file outside this list was touched. The only prior-sprint file
with behavior changes is Sprint 3's `verificationService.ts`, and only additively — every existing
Sprint 3 test still passes unchanged, proving `isFullyVerified` and its three other existing public
methods are byte-identical to before this sprint.

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 10 — Internal Financial Ledger & Reconciliation

Source: `docs/sprints/SPRINT_10_InternalFinancialLedger.md`. Developed on branch
`sprint-10-ledger-reconciliation`, branched from `master`'s tip (`d64bcae`, the Sprint 9 merge
commit; already up to date, no fast-forward needed).

### Scope delivered

- **Shadow ledger** (`src/lib/ledger/ledgerService.ts`): double-entry-style, balanced, append-only
  journal entries over a 6-account chart matching `docs/PAYMENT_ARCHITECTURE.md` §14
  (`processor_clearing`, `creditor_proceeds_payable`, `platform_fee_revenue`,
  `processor_fee_expense`, `creditor_clawback_exposure`, `admin_adjustment_suspense`). Every account
  is scoped to one `(account_type, agreement_id)` pair — no platform-wide singleton, so every
  balance traces deterministically to its agreement. `postPaymentCleared` (with processor/platform
  fee splits), `reversePayment` (refund/reversal/dispute_adjustment, auto-selecting pre-payout mirror
  vs. post-payout clawback shape), `postPayout`, and `postAdminAdjustment` are all idempotent, keyed
  by `(payment_attempt_id, entry_type)`.
- **`BalanceService`** (`src/lib/ledger/balanceService.ts`): reads Sprint 5's
  `agreement_version.terms.currentPrincipalMinorUnits` (read-only, never duplicated or mutated) and
  reconstructs amount-paid/remaining-balance/settlement-state entirely from `LedgerService`'s journal
  history — no cached balance field exists anywhere.
- **Webhook → ledger wiring** (`src/lib/payments/paymentWebhookService.ts`, additive to Sprint 9):
  `payment.succeeded` posts `payment_cleared`; `payment.refunded`/`payment.returned`/`payment.disputed`
  post the appropriate reversal; a new `payout.paid` event posts `payout` and sets
  `payment_attempt.payout_completed_at`. A ledger-posting failure (most commonly: no `agreementId`)
  is caught and logged, never fails the webhook or the already-applied status update — the resulting
  gap is exactly what reconciliation's `internal_posting_failure` check exists to catch.
- **`ReconciliationService`** (`src/lib/ledger/reconciliationService.ts`): real, independent
  detection logic for all 10 of the sprint's required exception types (missing/unmatched provider
  transaction, amount/currency mismatch, duplicate transaction, status mismatch, reversal/refund
  mismatch, stale pending settlement, internal posting failure, provider event without internal
  state). Idempotent re-run via an application-level "find open exception before inserting" check.
- **Admin visibility** (`src/lib/ledger/ledgerAdminService.ts`, new file — Sprint 6A's
  `adminService.ts` untouched): Platform Admin+ can view an agreement's ledger entries, balance, and
  reconciliation exceptions, list open exceptions, resolve them, and trigger a reconciliation run.
  Platform Owner only may post an administrative adjustment — always balanced against a dedicated
  suspense account, always reasoned, always audited, never an edit/delete of a prior entry.
- **Five new admin routes, no UI**: `GET /api/admin/ledger/{agreement,exceptions}`,
  `POST /api/admin/ledger/{exceptions/resolve,reconcile,adjustment}`.

### Files created (23)

Schema: `src/db/schema/ledger.ts`. Ledger/reconciliation/admin domain logic:
`src/lib/ledger/{ledgerService,drizzleLedgerAccountRepository,drizzleLedgerJournalEntryRepository,
getLedgerService,balanceService,drizzleAgreementTermsReader,getBalanceService,
reconciliationService,drizzleReconciliationExceptionRepository,getReconciliationService,
ledgerAdminService,getLedgerAdminService,testFakes,integrationTestFakes,ledgerService.test,
balanceService.test,reconciliationService.test,paymentLedgerIntegration.test,
ledgerAdminService.test}.ts` (53 tests). API routes:
`src/app/api/admin/ledger/{agreement/route,exceptions/route,exceptions/resolve/route,reconcile/route,
adjustment/route}.ts`. Migration: `drizzle/migrations/0011_slippery_payback.sql`
(+ `meta/0011_snapshot.json`).

### Files modified (11)

`src/db/schema/{enums,index,payment}.ts` (4 new ledger/reconciliation enums, `reversed` added to
`payment_attempt_status`, `payout_completed_at` column, export the new schema module);
`src/lib/payments/paymentService.ts` (additive: `"reversed"` status, `payoutCompletedAt` field,
`markPayoutCompleted`/`listAll` repository methods); `src/lib/payments/
{drizzlePaymentAttemptRepository,drizzlePaymentWebhookEventRepository,getPaymentWebhookService,
paymentWebhookService,testFakes}.ts` (ledger wiring + matching repository method additions);
`drizzle/migrations/meta/_journal.json`; `docs/SPRINT_CONTROL.md`.

### Tests

447/447 passing across 64 files (up from 394/59 at the end of Sprint 9 — 53 net new: 19 in
`ledgerService.test.ts`, 8 in `balanceService.test.ts`, 14 in `reconciliationService.test.ts`, 7 in
`paymentLedgerIntegration.test.ts`, 5 in `ledgerAdminService.test.ts`). Covers every one of the
sprint's named required-test categories: balance invariant, duplicate event, reversal, refund,
processor fee, payout, reconciliation mismatch — plus this session's added requirements: duplicate-post
prevention, payment success/failed-payment posting behavior, balance reconstruction (including
order-independence), reconciliation success/rerun-idempotency, unauthorized ledger access, admin
authorization (Platform Admin vs. Owner), immutable-agreement-terms protection, and integer-money
invariants. Sprints 1–9's own tests all still pass unchanged, including every Sprint 9
payment/webhook test (whose fixtures never set an `agreementId` — exercising this sprint's
fail-soft ledger-posting path for free).

### Verification commands run

`npx tsc --noEmit` — pass, no errors. `npx eslint .` — pass, 0 errors (6 pre-existing-pattern
warnings, unchanged from Sprint 9). `npx vitest run` — pass, 447/447 across 64 files. `npx next build`
— pass; all 5 new `/api/admin/ledger/*` routes generated correctly, no change to any existing
route's classification. `npx drizzle-kit check` — pass, migration history internally consistent, no
drift. RLS + `REVOKE ALL ... FROM anon, authenticated` confirmed present on all four new tables
(`ledger_account`, `ledger_journal_entry`, `ledger_posting`, `reconciliation_exception`).

### Git commit

**Not yet committed.** Per this session's explicit instruction, commit/push/PR is deferred until
after Product Owner review of this status entry. `git status` at the time of this report: modified
`docs/SPRINT_CONTROL.md`, `drizzle/migrations/meta/_journal.json`, `src/db/schema/{enums,index,
payment}.ts`, `src/lib/payments/{drizzlePaymentAttemptRepository,drizzlePaymentWebhookEventRepository,
getPaymentWebhookService,paymentService,paymentWebhookService,testFakes}.ts`; untracked
`drizzle/migrations/0011_slippery_payback.sql`, `drizzle/migrations/meta/0011_snapshot.json`,
`src/app/api/admin/ledger/`, `src/db/schema/ledger.ts`, `src/lib/ledger/`. No file outside this list
was touched. The only prior-sprint files with behavior changes are Sprint 9's payment/webhook files,
and only additively — every existing Sprint 9 test still passes unchanged, and Sprint 3's
verification-service files (touched in Sprint 9, not this sprint) were not touched again here.

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 11 — ACH Sandbox

Source: `docs/sprints/SPRINT_11_ACH_Sandbox.md`. Developed on branch `sprint-11-ach-sandbox`,
branched from `master`'s tip (`c902790`, the Sprint 10 merge commit).

### Scope delivered

- **Borrower mandate/authorization** (`src/lib/ach/achMandateService.ts`): authorize, revoke
  (append-only — revocation only ever sets `revoked_at`/`revoked_reason` on the existing row), and a
  bank-change hook (`handleBankChange`) that revokes the current mandate and authorizes a new one
  linked via `supersedes_mandate_id`, never mutating the old bank reference in place. Structurally
  incapable of touching ledger/balance/agreement data (no such dependency exists on the class) — the
  concrete mechanism behind "revocation stops future debits but does not erase debt."
- **Two-phase payment scheduling** (`src/lib/ach/achPaymentService.ts` on top of an extended
  `src/lib/payments/paymentService.ts`): `schedulePayment`/`submitPending` are new `PaymentService`
  methods sharing the exact idempotency/ownership/verification gate `createPayment` already had
  (extracted into a private `reserveAttempt` helper) — `AchPaymentService` never touches
  `PaymentProvider` directly, preserving Sprint 9's single-gate invariant. Covers first payment,
  recurring installments, and manual (ad-hoc) payments; requires an active mandate; prevents a
  second open attempt per installment (duplicate-debit prevention), backed by Sprint 9's existing
  idempotency-key DB uniqueness for the race-safe case.
- **Granular ACH lifecycle**: `payment_attempt_status` gains `scheduled`/`submitted`/`processing`
  (additive to Sprint 9's `pending`, which remains valid for non-ACH/simpler cases) and a corrected
  `returned` value. Payout-pending is tracked via a new `payoutInitiatedAt` timestamp alongside
  Sprint 10's existing `payoutCompletedAt`, mirroring that sprint's own precedent rather than
  overloading `status`.
- **Naming correction to Sprint 10**: `payment.returned` now sets status `"returned"` (not the
  mislabeled `"reversed"`), matching `docs/PAYMENT_STATE_MACHINE.md`'s canonical Returned (ACH) vs.
  Reversed (card chargeback, not applicable to ACH) distinction. `"reversed"` remains reserved for
  Sprint 12.
- **Six new routes, no UI**: `POST /api/ach/mandate`, `POST /api/ach/mandate/revoke`,
  `POST /api/ach/mandate/bank-change`, `POST /api/ach/payments/{schedule,submit,manual}`.

### Files created (14)

Schema: `src/db/schema/ach.ts`. ACH domain logic: `src/lib/ach/{achMandateService,
drizzleAchMandateRepository,getAchMandateService,achPaymentService,getAchPaymentService,testFakes,
achMandateService.test,achPaymentService.test}.ts` (21 tests). API routes:
`src/app/api/ach/mandate/{route,revoke/route,bank-change/route}.ts`,
`src/app/api/ach/payments/{schedule,submit,manual}/route.ts`. Migration:
`drizzle/migrations/0012_crazy_kylun.sql` (+ `meta/0012_snapshot.json`).

### Files modified (8)

`src/db/schema/{enums,index,payment}.ts` (4 new `payment_attempt_status` values, new
`ach_mandate_status` enum, `payoutInitiatedAt`/`installmentScheduleItemId` columns, export the new
schema module); `src/lib/payments/paymentService.ts` (additive: `schedulePayment`/`submitPending`,
`reserveAttempt`/`submitToProvider` extraction, `cancelPayment` now also accepts `"scheduled"`) +
matching `drizzlePaymentAttemptRepository.ts`/`testFakes.ts` updates (`findOpenByInstallment`,
`markPayoutInitiated`); `src/lib/payments/paymentWebhookService.ts` (the `returned` naming fix);
`src/lib/ledger/reconciliationService.ts` (small `missing_provider_transaction` guard for
`"scheduled"`, `returned` mapping fix) — one existing test's expectation updated to match
(`paymentLedgerIntegration.test.ts`); `drizzle/migrations/meta/_journal.json`;
`docs/SPRINT_CONTROL.md`.

### Tests

473/473 passing across 66 files (up from 447/64 at the end of Sprint 10 — 26 net new: precisely, 10
in `achMandateService.test.ts`, 11 in `achPaymentService.test.ts`, 5 new cases in
`paymentService.test.ts`). Covers all 8 of the sprint's named required-test categories: pending,
success, NSF, returned, revoked mandate, duplicate debit prevention, first payment failure, payout
only after cleared state. Sprints 1–10's own tests all still pass unchanged.

### Verification commands run

`npx tsc --noEmit` — pass, no errors. `npx eslint .` — pass, 0 errors (6 pre-existing-pattern
warnings, unchanged). `npx vitest run` — pass, 473/473 across 66 files. `npx next build` — pass; all
6 new `/api/ach/*` routes generated correctly, no change to any existing route's classification.
`npx drizzle-kit check` — pass, migration history internally consistent, no drift (purely additive:
one new enum, four `ALTER TYPE ADD VALUE`s, one new table, two new nullable columns, two new FKs).
RLS + `REVOKE ALL ... FROM anon, authenticated` confirmed present on the one new table
(`ach_mandate`).

### Git commit

**Not yet committed.** Per this session's explicit instruction ("do NOT commit or push yet unless
Sprint control explicitly requires it — first report for Product Owner review"), commit/push is
deferred until after Product Owner review of this status entry. `git status` at the time of this
report: modified `docs/SPRINT_CONTROL.md`, `drizzle/migrations/meta/_journal.json`,
`src/db/schema/{enums,index,payment}.ts`, `src/lib/ledger/{paymentLedgerIntegration.test,
reconciliationService}.ts`, `src/lib/payments/{drizzlePaymentAttemptRepository,paymentService,
paymentService.test,paymentWebhookService,testFakes}.ts`; untracked
`drizzle/migrations/0012_crazy_kylun.sql`, `drizzle/migrations/meta/0012_snapshot.json`,
`src/app/api/ach/`, `src/db/schema/ach.ts`, `src/lib/ach/`. No file outside this list was touched.
The only prior-sprint files with behavior changes are Sprint 9's `paymentService.ts`/
`paymentWebhookService.ts` and Sprint 10's `reconciliationService.ts`, all additively — every
existing Sprint 9/10 test still passes unchanged except the one `paymentLedgerIntegration.test.ts`
case whose expected status string the naming correction required.

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 12 — Debit Card Sandbox

Source: `docs/sprints/SPRINT_12_DebitCard_Sandbox.md`. Implemented in this session's worktree,
sequenced immediately after Sprint 11 (ACH) per `docs/SPRINT_CONTROL.md`'s own dependency graph.

### Scope delivered

- **Card on file** (`src/lib/debitCard/debitCardMethodService.ts`): register, replace (append-only —
  `replaceCard` marks the old `debit_card_method` row `"replaced"` and inserts a new row linked via
  `supersedes_card_method_id`, mirroring `ach_mandate`'s bank-change pattern), and a lazy expiry
  check (`isCardExpired`) rather than a stored transition — `registerCard`/`replaceCard` also refuse
  an expiry already in the past. Structurally incapable of touching ledger/balance/agreement data,
  same guarantee as `AchMandateService`.
- **Card payment orchestration** (`src/lib/debitCard/debitCardPaymentService.ts` on top of Sprint 9's
  unmodified `PaymentProvider` interface and the same `PaymentService.schedulePayment`/`submitPending`
  gate ACH uses): covers initial payment, recurring installments, and manual payments; requires an
  active, unexpired card; reuses Sprint 11's duplicate-debit prevention as-is.
- **Fee-allocation engine** (`src/lib/debitCard/cardFeeAllocation.ts`): implements this sprint's fee
  rule — the borrower is surcharged the incremental card-vs-ACH processing cost on top of the
  scheduled amount, unless the agreement's existing `feeAllocation` term is `"creditor_pays"`
  (already reads as "the agreement states otherwise" — no new agreement field was added). The
  surcharge is added to what's actually collected, not implemented as a ledger-only split, so
  creditor net proceeds are structurally preserved rather than merely asserted.
- **`payment_attempt.paymentMethod`** (new nullable `"ach" | "debit_card"` column, additive across
  `PaymentAttemptRecord`/`PaymentAttemptRepository`/`PaymentService`): satisfies master spec §6's
  "must separately track ACH and card payment states" — every pre-Sprint-12 row/test is unaffected
  (defaults to `null`).
- **Card chargeback wiring**: `PaymentWebhookService`'s existing event-to-transition maps gained
  `"payment.reversed"` → `"reversed"` status / `"reversal"` ledger entry — activates the `"reversed"`
  enum value Sprint 10 reserved and Sprint 11 confirmed is card-only. Zero `LedgerService` changes
  were needed; its existing pre/post-payout reversal logic already generalizes to this case.
- Refund and dispute (the non-chargeback `"disputed"` status) needed no new code at all — both are
  already fully generic in Sprint 9/10's existing `PaymentService.refundPayment` and
  `PaymentWebhookService`'s `"payment.disputed"` handling.

### Files created (19)

`src/db/schema/debitCard.ts`; `src/lib/debitCard/{agreementFeeAllocationReader,
drizzleAgreementFeeAllocationReader,cardFeeAllocation,cardFeeAllocation.test,debitCardMethodService,
debitCardMethodService.test,drizzleDebitCardMethodRepository,getDebitCardMethodService,
debitCardPaymentService,debitCardPaymentService.test,getDebitCardPaymentService,testFakes}.ts`; API
routes: `src/app/api/debit-card/{register/route,replace/route,payments/schedule/route,
payments/submit/route,payments/manual/route}.ts`. Migration: `drizzle/migrations/0013_busy_anthem.sql`
(+ `meta/0013_snapshot.json`).

### Files modified (6)

`src/db/schema/{enums,index,payment}.ts` (2 new enums — `payment_method`, `debit_card_method_status`
— + `paymentMethod` column, export the new schema module); `src/lib/payments/paymentService.ts`
(additive: `PaymentMethod` type, `paymentMethod` field threaded through `PaymentAttemptRecord`/
`insertPending`/`createPayment`/`schedulePayment`/`reserveAttempt`) + matching
`drizzlePaymentAttemptRepository.ts`/`testFakes.ts` updates; `src/lib/payments/paymentWebhookService.ts`
(two new map entries, `"payment.reversed"`); `docs/SPRINT_CONTROL.md`.

### Tests

504/504 passing across 69 files (up from 475 immediately before this sprint — see the test-count
note in `docs/SPRINT_CONTROL.md`'s Sprint 12 row for why that baseline isn't 473; 29 net new: 6 in
`cardFeeAllocation.test.ts`, 10 in `debitCardMethodService.test.ts`, 13 in
`debitCardPaymentService.test.ts`). Covers all 8 of the sprint's named required-test categories:
approved, decline, expired, dispute, refund, card replacement, fee allocation, duplicate request.
Sprints 1–11's own tests all still pass unchanged.

### Verification commands run

`npm ci` (this worktree's own `node_modules` was otherwise nearly empty — a session/environment
artifact of running inside an isolated git worktree, not a code issue) then: `npx tsc --noEmit` —
pass, no errors. `npx eslint .` — pass, 0 errors (6 pre-existing-pattern warnings in files this
sprint never touched, unchanged). `npx vitest run` — pass, 504/504 across 69 files. `npx next build`
(Turbopack) — pass; all 5 new `/api/debit-card/*` routes generated correctly, no change to any
existing route's classification. `npx drizzle-kit check` — pass, migration history internally
consistent, no drift (purely additive: two new enums, one new table, one new nullable column, one
new FK). RLS + `REVOKE ALL ... FROM anon, authenticated` confirmed present on the one new table
(`debit_card_method`) — added by hand to the generated migration, matching every prior migration in
this project (`drizzle-kit generate` does not emit `REVOKE` on its own).

### Git commit

**Not yet committed.** Per this session's explicit instruction ("Do not commit, push, merge, deploy,
or begin the next sprint unless the existing Sprint Control instructions specifically authorize that
action at this stage"), commit/push is deferred until after Product Owner review of this status
entry — matching Sprints 5–11's own precedent of deferring until review. No file outside the
created/modified lists above was touched. The only prior-sprint files with behavior changes are
Sprint 9's `paymentService.ts` and `paymentWebhookService.ts`, both additively — every existing
Sprint 9/10/11 test still passes unchanged.

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 13 — Failed Payments & Retry Workflow

Source: `docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md`. Implemented in a fresh worktree
branched from `origin/master`'s tip (`1785466`, the Sprint 12 merge commit).

### Scope delivered

- **Retry scheduling/firing** (`src/lib/failedPayments/paymentRetryService.ts`): schedules exactly
  one retry (configurable delay, default ~3 business days, `addBusinessDays` skipping weekends) per
  failed installment payment; fires via a cron-triggered route, never a persistent worker (Vercel has
  none); cancels if a manual payment clears the installment first; structurally cannot schedule a
  second retry for a retry's own failure (two independent checks — see implementation notes in
  `docs/SPRINT_CONTROL.md`).
- **Installment status** (`src/lib/failedPayments/installmentStatusRepository.ts`): the first code in
  this project to ever write `installment_schedule_item.status` — past_due on failure, paid on
  success. A real pre-existing gap since Sprint 5, closed here.
- **Notifications** (`src/lib/notify/notificationService.ts`): durable `notification_event` record +
  best-effort delivery through the existing `EmailSender`/`ConsoleEmailSender` (Sprint 2), per
  `docs/SPRINT_CONTROL.md`'s own "Sequencing risk 1" resolution — Sprint 17 wires real channels on
  top of these same rows later.
- **Reschedule request/approval** (`src/lib/failedPayments/rescheduleRequestService.ts`): borrower
  requests a new due date; the installment's `due_date` is written only inside the creditor's
  approval branch, never on request alone.
- **Two pre-existing bugs found and fixed by this sprint's own tests** (not just described): (1)
  `PaymentWebhookService` never captured `failureCategory` from a `payment.failed` webhook into
  `failureReason` — silently discarded since Sprint 9; (2) `AchPaymentService` never tagged
  `payment_attempt.payment_method`, only debit card (Sprint 12) did, breaking master spec §6's
  "track ACH and card payment states separately" and this sprint's own retry-firing (which needs the
  method to pick the right service to retry through).
- **Background-job/scheduler abstraction compatible with Vercel architecture**: `POST
  /api/scheduler/retry-failed-payments`, `CRON_SECRET`-gated (`Authorization: Bearer`, matching
  Vercel Cron Jobs' own convention), configured in a new `vercel.json`. No queue infrastructure was
  built — Vercel has no persistent process to run one on.

### Files created (29)

`src/db/schema/paymentRetry.ts`; `src/lib/notify/{notificationService,notificationService.test,
drizzleNotificationEventRepository,drizzleUserContactReader,getNotificationService,testFakes}.ts`;
`src/lib/failedPayments/{businessDays,businessDays.test,installmentStatusRepository,
drizzleInstallmentStatusRepository,paymentRetryService,paymentRetryService.test,
drizzlePaymentRetryRepository,getPaymentRetryService,failedPaymentWorkflowService,
getFailedPaymentWorkflowService,rescheduleRequestService,rescheduleRequestService.test,
drizzleRescheduleRequestRepository,drizzleAgreementPartiesReader,getRescheduleRequestService,
testFakes}.ts`; routes: `src/app/api/scheduler/retry-failed-payments/route.ts`,
`src/app/api/installments/reschedule/{request,decide}/route.ts`; `vercel.json`. Migration:
`drizzle/migrations/0014_chubby_argent.sql` (+ `meta/0014_snapshot.json`).

### Files modified (12, plus the routine `drizzle/migrations/meta/_journal.json` companion)

`src/db/schema/{enums,index}.ts` (3 new enums, export the new schema module); `src/config/env.ts`
(`CRON_SECRET`, optional); `.env.example`, `docs/ENVIRONMENT_VARIABLES.md` (`CRON_SECRET`
documented); `src/lib/payments/paymentWebhookService.ts` (failureCategory capture fix + one new
optional `failedPaymentWorkflow` dependency) + matching `testFakes.ts` update;
`src/lib/payments/getPaymentWebhookService.ts` (wires the new dependency in production);
`src/lib/ach/achPaymentService.ts` (payment_method tagging fix + optional
`installmentScheduleItemId` on `createManualPayment`); `src/lib/debitCard/debitCardPaymentService.ts`
(matching optional `installmentScheduleItemId` on `createManualPayment`); `docs/SPRINT_CONTROL.md`,
`docs/PROGRESS.md`.

### Tests

524/524 passing across 73 files (up from 504 at the end of Sprint 12 — 20 net new: 3 in
`businessDays.test.ts`, 2 in `notificationService.test.ts`, 7 in `paymentRetryService.test.ts`, 8 in
`rescheduleRequestService.test.ts`, the 8th added during the Product Owner review pass — see
`docs/SPRINT_CONTROL.md`). Covers all 6 of the sprint's named required-test categories: initial
failure, retry, manual success cancels retry, retry failure, no third automatic retry, reschedule
request. Sprints 1–12's own tests all still pass unchanged.

### Verification commands run

`npm ci` (this worktree's own `node_modules` was otherwise nearly empty — a worktree-isolation
artifact, not a code issue, same as Sprint 12's own note) then: `npx tsc --noEmit` — pass, no errors.
`npx eslint .` — pass, 0 errors (6 pre-existing-pattern warnings in files this sprint never touched,
unchanged). `npx vitest run` — pass, 524/524 across 73 files. `npx next build` (Turbopack) — pass;
all 3 new routes (`/api/scheduler/retry-failed-payments`,
`/api/installments/reschedule/{request,decide}`) generated correctly, no change to any existing
route's classification. `npx drizzle-kit check` — pass, migration history internally consistent, no
drift (purely additive: 2 new enums, 3 new tables, 0 altered/dropped columns). RLS +
`REVOKE ALL ... FROM anon, authenticated` confirmed present on all three new tables.

### Git commit

**Not yet committed.** Per this session's explicit instruction ("Do not commit, push, merge, deploy,
or begin Sprint 14 unless docs/SPRINT_CONTROL.md specifically authorizes that action at this stage"),
commit/push is deferred until after Product Owner review of this status entry — matching Sprints
5–12's own precedent. No file outside the created/modified lists above was touched. Sprint 9's
`paymentWebhookService.ts` and Sprint 11/12's `achPaymentService.ts`/`debitCardPaymentService.ts` are
the only prior-sprint files with behavior changes, all additively — every existing Sprint 9–12 test
still passes unchanged.

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 14 — Amendments & Hardship

Source: `docs/sprints/SPRINT_14_Amendments_Hardship.md`. Implemented in a fresh worktree branched
from `origin/master`'s tip (`fed954c`, the Sprint 13 merge commit).

### Scope delivered

- **Amendment lifecycle** (`src/lib/amendments/amendmentService.ts`), matching
  `docs/STATE_MACHINES.md` §3 exactly: `Proposed → AwaitingSignatures → Signed → Applied`, with
  `Proposed → Rejected`/`Withdrawn` and `AwaitingSignatures → Withdrawn` also supported. Either party
  may propose (new date, temporary pause, reduced installment, revised schedule, or general
  contractual change); only the counterparty may accept/reject/counter; counter mutates the same
  proposal in place (mirrors `AgreementService.creditorDecide`'s identical pre-signature mechanic)
  and flips whose turn it is to respond.
- **Dual signature → new immutable version**: once both parties sign, a new `agreement_version` is
  created (via the exact same `AgreementVersionRepository`/`InstallmentScheduleItemRepository` Sprint
  5 itself uses), becomes the agreement's current version, and — for `temporary_pause` amendments
  only — transitions the agreement to `paused_by_amendment`. The original version is never touched.
- **"No interest, no penalty growth" enforced by construction**: `AgreementTerms` has no
  interest/penalty field anywhere in this codebase, so there's no field an amendment could populate
  even if it tried.
- **Single-table `amendment` model**, a deliberate scope decision vs. `docs/DATA_MODEL.md`'s
  illustrative two-table `amendment`/`hardship_request` split — see `docs/SPRINT_CONTROL.md`'s
  "Sprint 14 implementation notes" for the full rationale.
- `buildTerms` was exported from `agreementService.ts` (previously module-private) so amendments
  validate/compute proposed terms through the exact same path the original draft uses.

### Files created (12)

`src/db/schema/amendment.ts`; `src/lib/amendments/{amendmentService,amendmentService.test,
drizzleAmendmentRepository,getAmendmentService,testFakes}.ts`; routes:
`src/app/api/agreements/amendments/{propose,decide,sign,withdraw}/route.ts`. Migration:
`drizzle/migrations/0015_damp_young_avengers.sql` (+ `meta/0015_snapshot.json`).

### Files modified (6)

`src/db/schema/{enums,index}.ts` (2 new enums, export the new schema module);
`src/lib/agreements/agreementService.ts` (`buildTerms` exported, otherwise byte-identical — every
existing Sprint 5 test still passes unchanged); `drizzle/migrations/meta/_journal.json`;
`docs/SPRINT_CONTROL.md`, `docs/PROGRESS.md`.

### Tests

538/538 passing across 74 files (up from 524 at the end of Sprint 13 — 14 net new, all in
`amendmentService.test.ts`, including 2 added during the Product Owner review pass — see
`docs/SPRINT_CONTROL.md`). Covers all 7 of the sprint's named required-test categories: proposal,
rejection, counter, dual acceptance, version creation, original preserved, unauthorized change
blocked — plus additional coverage for the `temporary_pause` status transition, non-pause amendments
leaving agreement status untouched, withdrawal, the full audit trail, the `approve_agreement`
capability gate on creditor-side decisions, and signature-evidence context (ipAddress/deviceInfo)
recording on the signing action. Sprints 1–13's own tests all still pass unchanged, including every
Sprint 5 `agreementService.test.ts` case.

### Verification commands run

`npm ci` (this worktree's own `node_modules` was otherwise nearly empty — a worktree-isolation
artifact, not a code issue, same as Sprints 12–13's own notes) then: `npx tsc --noEmit` — pass, no
errors. `npx eslint .` — pass, 0 errors (6 pre-existing-pattern warnings in files this sprint never
touched, unchanged). `npx vitest run` — pass, 538/538 across 74 files. `npx next build` (Turbopack)
— pass; all 4 new `/api/agreements/amendments/*` routes generated correctly, no change to any
existing route's classification. `npx drizzle-kit check` — pass, migration history internally
consistent, no drift (purely additive: 2 new enums, 1 new table, 0 altered/dropped columns). RLS +
`REVOKE ALL ... FROM anon, authenticated` confirmed present on the one new table (`amendment`).

### Git commit

**Not yet committed.** Per this session's explicit instruction ("Do not commit, push, merge, deploy,
or begin Sprint 15 unless docs/SPRINT_CONTROL.md specifically authorizes that action at this stage"),
commit/push is deferred until after Product Owner review of this status entry — matching Sprints
5–13's own precedent. No file outside the created/modified lists above was touched. Sprint 5's
`agreementService.ts` is the only prior-sprint file with a behavior change, and it's purely additive
(one new export, no logic changed) — every existing Sprint 5 test still passes unchanged.

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**

## Sprint 15 — Partial Payments & Settlement

Source: `docs/sprints/SPRINT_15_ PartialPayments_Settlement.md`. Implemented in a fresh worktree
branched from `origin/master`'s tip (`9f8dc9e`, the Sprint 14 merge commit).

### Scope delivered

- **Partial-payment lifecycle** (`src/lib/partialPayments/partialPaymentService.ts`), matching
  `docs/STATE_MACHINES.md` §5 (collapsed — see `docs/SPRINT_CONTROL.md`'s "Sprint 15 implementation
  notes"): `proposed → awaiting_payment → applied`, with `proposed → rejected` and
  `awaiting_payment → expired` also supported. Only the borrower may propose (master spec §11);
  only the counterparty may accept/reject/counter; counter mutates the same request in place and
  flips whose turn it is to respond, mirroring `AmendmentService`'s identical mechanic. Acceptance
  never touches `agreement.status` or creates a new version — the remaining balance stays due unless
  a separate Settlement covers it.
- **Settlement lifecycle** (`src/lib/settlements/settlementService.ts`), matching
  `docs/STATE_MACHINES.md` §6 (collapsed): `proposed → awaiting_payment → completed` or
  `→ failure_consequence_applied`. Either party may propose, capturing every §12-required field
  (pre-settlement balance, settlement amount, forgiven amount, deadline, one-time-vs-scheduled, and
  one of the four explicit failure-consequence options). Every creditor action capable of fixing
  binding-capable settlement terms — proposing, countering, or finalizing acceptance — requires both
  the `approve_settlement` capability and Sprint 2's `MfaService.requireStepUp(user,
  "approve_settlement")`; widened from "creditor accepts" alone during this sprint's own Product Owner
  review pass, which found and closed a real gap (see `docs/SPRINT_CONTROL.md`'s "Sprint 15 Product
  Owner review pass").
- **Settlement payment collection and completion**: `recordSettlementPayment` links an
  already-succeeded `payment_attempt` (collected through the existing Sprint 9–13 payment gate, never
  a separate money-movement path) to a settlement via a new `settlement_payment` join table, summing
  every linked cleared payment to support both one-time and scheduled modes. Once the full settlement
  amount clears, the agreement is marked `settled_in_full` — this class has no code path capable of
  writing `paid_in_full`.
- **All four failed-settlement consequences**, resolved by `expireOverdueSettlements` (a Sprint
  13-precedent cron entry point) and recorded declaratively on `settlement_proposal.resolved_*`
  columns: `restore_original` (pre-settlement balance minus whatever partial payments already
  cleared), `restore_stated` (the exact amount stated at proposal time), `forgive_permanently` (the
  exact amount stated at proposal time), `prior_agreement_controls` (declarative only — nothing
  numeric to resolve).
- Both cron-firing expirations (`PartialPaymentService.expireOverdue`,
  `SettlementService.expireOverdueSettlements`) share one new route,
  `POST /api/scheduler/expire-negotiations`, mirroring Sprint 13's `retry-failed-payments` route
  exactly (`CRON_SECRET` Bearer auth, constant-time comparison, one new daily `vercel.json` entry).

### Files created (21)

`src/db/schema/{partialPayment,settlement}.ts`;
`src/lib/partialPayments/{partialPaymentService,partialPaymentService.test,
drizzlePartialPaymentRepository,getPartialPaymentService,testFakes}.ts`;
`src/lib/settlements/{settlementService,settlementService.test,drizzleSettlementRepository,
getSettlementService,testFakes,validation}.ts`; routes:
`src/app/api/agreements/partial-payments/{propose,decide,record-payment}/route.ts`,
`src/app/api/agreements/settlements/{propose,decide,record-payment}/route.ts`,
`src/app/api/scheduler/expire-negotiations/route.ts`. Migration:
`drizzle/migrations/0016_blushing_adam_destine.sql` (+ `meta/0016_snapshot.json`).

### Files modified (4)

`src/db/schema/{enums,index}.ts` (4 new enums, export the two new schema modules);
`vercel.json` (one new daily cron entry); `drizzle/migrations/meta/_journal.json`.
(`docs/SPRINT_CONTROL.md`/`docs/PROGRESS.md` also modified, as with every prior sprint's
documentation update — not counted above, matching Sprint 14's own convention.)

### Tests

576/576 passing across 78 files (up from 538 at the end of Sprint 14 — 38 net new: 13 in
`partialPaymentService.test.ts`, 25 in `settlementService.test.ts`, including 4 added during the
Product Owner review pass). Covers: proposal (borrower-only for partial payment, either-party for
settlement), rejection, counter (with the turn-flip and "proposer cannot decide their own proposal"
guard), the `approve_partial_payment`/`approve_settlement` capability gates on every creditor action
(decide *and* propose/counter, per the review-pass widening), the creditor step-up gate on every
creditor action capable of fixing binding-capable terms (propose, counter, accept — each blocked
without a fresh step-up, allowed once granted, confirmed *not* required for any debtor action, and
confirmed not to leak forward from one gated action to a later one), payment recording
(amount-mismatch and not-yet-succeeded rejections), "acceptance does not forgive the remainder"
(agreement status/version asserted unchanged), settlement completion marking `settled_in_full` and
explicitly asserting `not.toBe("paid_in_full")`, scheduled-mode multi-payment summing, expiry of
overdue negotiations, and all four failure consequences individually (including that the resolved
consequence always matches the one chosen at proposal time). Sprints 1–14's own tests all still pass
unchanged.

### Verification commands run

`npm ci` (this worktree's own `node_modules` was otherwise nearly empty — a worktree-isolation
artifact, not a code issue, same as every prior worktree sprint's own note) then: `npm run typecheck`
(`tsc --noEmit`, this project's own authoritative gate) — pass, 0 errors (see `docs/SPRINT_CONTROL.md`'s
"Sprint 15 Product Owner review pass" for why a bare `tsc --noEmit` run before any build/dev pass in a
fresh worktree reports a false-positive `LayoutProps` error that disappears once `.next/types` exists —
confirmed not a Sprint 15 regression). `npx eslint .` — pass, 0 errors (6 pre-existing-pattern warnings
in files this sprint never touched, unchanged). `npx vitest run` — pass, 576/576 across 78 files. `npx
next build` (Turbopack) — pass, including its own TypeScript pass (0 errors); all 7 new routes generated
correctly, no change to any existing route's classification. `npx drizzle-kit check` — pass, migration
history internally consistent, no drift (purely additive: 4 new enums, 3 new tables, 0 altered/
dropped columns). RLS + `REVOKE ALL ... FROM anon, authenticated` confirmed present on all three new
tables (`partial_payment_request`, `settlement_proposal`, `settlement_payment`).

### Git commit

**Not yet committed.** Per this session's explicit instruction ("Do not commit, push, merge, deploy,
or begin Sprint 16 unless docs/SPRINT_CONTROL.md specifically authorizes that action at this stage"),
commit/push is deferred until after Product Owner review of this status entry — matching Sprints
5–14's own precedent. No file outside the created/modified lists above was touched. No prior-sprint
production file was modified — this sprint is purely additive at the file level (only `enums.ts`,
`schema/index.ts`, and `vercel.json` gained new entries; no existing function body changed).

### GitHub CI / Vercel preview

Not applicable yet — no commit, no branch push, no PR opened.

### ChatGPT/Product Owner review

**NOT YET REVIEWED.**
