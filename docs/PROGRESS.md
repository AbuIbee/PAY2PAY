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

See `docs/SPRINT_CONTROL.md`'s "Sprint 2 branch/CI/Vercel record" section for the outcome of this
sprint's explicit CI-gate requirement (push branch, confirm CI passes, confirm Vercel preview
builds) — completed as the final step of this sprint, after this document was first written.
