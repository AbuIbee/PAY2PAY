# End-to-End (Playwright) Tests

**Added:** SPRINT_20_ClosedBetaReadiness — the "complete end-to-end test suite" this sprint's spec
names as a required deliverable. Run with `npm run e2e` (starts the dev server automatically) or
`npx playwright test` directly.

## What this covers

Real browser verification (via a headless Chromium driven by Playwright, not code inspection) of:

- Unauthenticated marketing/auth pages render correctly with proper labels, no console errors, no
  `localhost` references, no developer-only placeholder text (`pages.spec.ts`).
- Protected pages correctly gate their content behind authentication — an anonymous visitor sees an
  explicit "you need to sign in" message, not a blank page, a crash, or leaked data
  (`auth-boundary.spec.ts`).
- Security headers (CSP, HSTS, X-Content-Type-Options, etc.) are actually present on real responses,
  not just declared in `next.config.ts` (`security-headers.spec.ts`).
- The application fails safely (a generic client-facing message, no internal detail/stack trace
  leaked) when required environment configuration is missing — verified directly during this
  sprint's manual pass; see `docs/sprints/SPRINT_20_COMPLETION_REPORT.md` for the evidence, not
  re-encoded as an automated test here since it requires deliberately un-setting required config,
  which would be unsafe to run against a shared/CI environment.

## What this does NOT cover, and why

**Authenticated, data-driven journeys (signup → verify → create an agreement → invite a counterparty
→ make a payment → see it reconciled) are not exercised here.** This sandboxed development
environment has no disposable Postgres/Docker daemon (a limitation every prior sprint's completion
report has already documented — `db:fresh-migration-test` cannot run locally for the same reason),
and the only real database this project has ever been configured against is the linked production
Supabase project. Running signup/payment flows through a real browser against that database would
write real test data into production — exactly what this sprint's own "closed-beta data safety"
instruction (§17) guards against. This was a deliberate, disclosed scope decision, not an oversight.

**To extend this suite to authenticated journeys**, the next step is provisioning a genuinely
disposable staging Supabase project (or a CI-only Postgres service container, matching
`.github/workflows/ci.yml`'s `fresh-migration-test` job's own pattern) that Playwright can safely
write test accounts and payments into and reset between runs. That is real, valuable follow-up work —
recorded as a known limitation in the Sprint 20 completion report, not silently treated as complete.

## Local development note

Running `npm run e2e` locally launches the dev server with dummy, non-functional database credentials
(mirroring CI's own `Lint, typecheck, test, build` job env) — enough for anonymous-visitor routes to
resolve cleanly (no session cookie means no database call is ever made, see
`src/lib/auth/requireSession.ts`), but any route that actually queries the database will fail. This is
intentional: it is the same reason these specs never attempt to log in or submit a form that would
require a real database.
