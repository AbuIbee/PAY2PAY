# PRSprint 11A: Login Authentication Regression Remediation

## Trigger

A production regression was reported after PRSprint 10A shipped: sign-out UI became visible and
usable (10A's own deliverable), but login authentication stopped working. PRSprint 11 had already
completed successfully by the time this was reported; the Product Owner explicitly directed that
PRSprint 11 not be assumed guilty, and that the PRSprint 10A diff be inspected first, without rolling
10A back wholesale unless the evidence required it.

This is an out-of-sequence, urgent remediation sprint. PRSprint 12 is explicitly NOT started as part
of this work.

## Goal

Restore login in production without undoing PRSprint 10A's logout/mobile-navigation fix. Prove the
actual failure path with evidence (git diff, live production logs) rather than guessing.

## Regression analysis performed

1. **Identified PRSprint 10A's exact merge** and diffed three points: the last commit before 10A, the
   10A merge commit, and current master (through PRSprint 11).
2. **`git diff` of the 10A merge (8 files changed)**: `docs/prsprints/PRSPRINT_10A_*.md`,
   `docs/prsprints/PRSPRINT_CONTROL.md`, `src/app/(app)/app-shell.css`,
   `src/app/api/auth/logout/route.test.ts`, `src/app/api/auth/logout/route.ts`,
   `src/components/AccountDashboard.tsx`, `src/components/AppNav.test.tsx`, `src/components/AppNav.tsx`.
   Every non-doc file touched is on the **logout** or **navigation-shell** path. None of them is the
   login route, the auth service, session creation, or cookie-setting code for login.
3. **`git diff` from the 10A merge through PRSprint 11 (13 files)**: all 13 are in the
   agreements/amendments domain (PRSprint 11's actual scope) — zero overlap with anything
   auth-related.
4. **`git log` on every login/session/cookie file** (`src/app/api/auth/login/route.ts`,
   `src/lib/auth/authService.ts`, `src/lib/auth/cookies.ts`, `src/components/LoginForm.tsx`) shows
   their last touches were PRSprint 06, 05, and earlier — **PRSprint 10A and 11 never modified any of
   them.**
5. **Full-content re-review of the two PRSprint 10A auth-adjacent changes**, to rule out any
   less-obvious mechanism (an over-broad cookie clear, a router-refresh side effect, etc.):
   - `logout/route.ts` — 10A added one line clearing `p2p_active_profile` (the business-context
     cookie) alongside the session cookie, scoped to `path: "/"`, only inside the logout handler.
     This only runs when `POST /api/auth/logout` is called; it cannot fire during login or page load.
   - `AccountDashboard.tsx` — 10A added `router.refresh()` after `router.push("/login")`, both inside
     `AccountDashboard`'s own `handleLogout`. This does not touch cookies and only runs after logout.
   - Confirmed no `middleware.ts` exists anywhere in the project — so "middleware rejects the new
     session" (category C) is not a mechanism available to be broken here at all.

**Conclusion: PRSprint 10A's diff is not the cause.** None of failure categories A–H (as listed in
the trigger — cookie never set, cookie deleted, middleware rejection, redirect loop, 10A logout code
firing during login, business-context cleanup deleting the session, cookie-attribute changes, or
mobile/topbar auth-detection breakage) match any code 10A actually touched.

## Root cause (category I: a distinct, pre-existing regression)

Live production diagnosis (`curl` against `https://paid2you.com`, cross-referenced with a
`vercel logs` tail against the live deployment while triggering real requests) found:

- `POST /api/auth/login` with valid-shaped credentials → HTTP 500 `INTERNAL_ERROR`.
- `POST /api/auth/signup` with a fresh throwaway account → the same HTTP 500 `INTERNAL_ERROR`.
- The captured server log for the signup 500 is a `DrizzleRateLimitStore.incrementAndCheck` query
  failure ("Failed query" against the `rate_limit_bucket` table's atomic upsert), thrown from inside
  `checkRateLimit()` in `src/lib/rate-limit.ts`.

**`checkRateLimit()` is called unconditionally, before any other logic, by both
`POST /api/auth/login` and `POST /api/auth/signup`** (`src/app/api/auth/login/route.ts:35-42`). Before
this fix, `checkRateLimit` had no error handling: any failure from the underlying store — a
database-level problem with the `rate_limit_bucket` write path, introduced in PRSprint 05 and never
previously exercised end-to-end against the live production database — propagated straight out as an
uncaught exception, producing a generic 500 for the entire request. This explains why login and
signup failed identically and symmetrically, and is unrelated to PRSprint 10A or 11.

**Exact PRSprint 10A file/line/component responsible: none.** The evidence above rules out PRSprint
10A's diff. The actual defect is in `src/lib/rate-limit.ts`, a file PRSprint 05 introduced and no
PRSprint since has touched — it simply had never been exercised against a real, live database write
failure until now.

The exact underlying Postgres error beneath Drizzle's "Failed query" wrapper was not retrievable from
the captured log line (Drizzle's error serialization did not surface `.cause`). Whether the
`rate_limit_bucket` write failure itself is a transient infra blip, a connection-pool limit, or
something else remains an open, separately-trackable infrastructure question — see Known Limitations
below. It does not change the code-level fix required here.

## Login end-to-end trace

Steps 1–4 (open login page → enter credentials → reach auth service → password verification) and
steps 5–12 (session creation → cookie issuance → browser receipt/retention → redirect → protected
page → session lookup → survives refresh) are all downstream of step "reach the route handler at
all" — and the route handler was throwing before it ever reached `authService.login(...)`, at the
rate-limit check that gates entry to the handler. **The exact failing step is between "1. user submits
credentials" and "3. credentials reach the authentication service"**: the request never got past the
route's own rate-limit gate.

## Fix

`checkRateLimit()` in `src/lib/rate-limit.ts` now wraps the store call in a try/catch and **fails
open**: on a store error, it logs the failure at `error` level (namespace and error message only — no
raw key, so no PII/IP/email is logged) and returns `true`, allowing the request through to continue to
real authentication (password verification + session validation), which remains the actual security
boundary and is untouched by this change.

This is a deliberate defense-in-depth tradeoff: rate limiting exists to slow down abuse, not to gate
whether the application can authenticate anyone at all. A rate-limiter *storage* failure taking down
every login and signup is a strictly worse outcome than rate limiting being briefly ineffective while
the storage problem is investigated and fixed. The failure is still fully observable (logged at
`error`, distinct from the normal `warn`-level "blocked" log), so it cannot silently persist unnoticed.

No PRSprint 10A code was modified by this fix.

## Cookie review (PRSprint 10A logout hardening re-audited)

Re-confirmed via full-content review of `logout/route.ts` and `AccountDashboard.tsx`:
- Logout clears exactly two cookies: `p2p_session` (via the existing `clearSessionCookie`) and
  `p2p_active_profile` (10A's addition), both scoped to `path: "/"`, both only inside the logout
  handler.
- Neither cookie is cleared on normal page load, login, or router refresh — `router.refresh()` in
  `AccountDashboard` only re-runs Next.js server components with the current cookie state; it does
  not itself write or clear any cookie.
- No overly broad cookie name, no path/domain mismatch, no clearing of a newly-created login session.
- Server and browser cookie state stay consistent: the `Set-Cookie: ...=""; Expires: <epoch>` response
  on logout is exactly what makes the browser drop its own copy.

**PRSprint 10A's logout fix is confirmed intact and untouched by this remediation.**

## Required tests (added — `src/lib/rate-limit.test.ts`, `src/app/api/auth/login-logout-cycle.test.ts`)

- `checkRateLimit` fails open (returns `true`, does not throw) when the store itself throws; logs at
  `error` level with the namespace only (no raw key); recovers correctly on the next call once the
  store is healthy again.
- Valid login: correct credentials reach a protected route.
- Invalid login: an incorrect password is rejected.
- Session persistence: login → refresh (re-request with the same cookie) → still logged in.
- Logout: login → logout → protected route denied.
- **Mandatory regression test: login → logout → login again → the second login succeeds**, its new
  session works, and the old (now-revoked) session stays denied.
- Multiple login/logout cycles (3x): each cycle leaves the session in the correct state.
- Browser Back: login → logout → Back (old cookie resent) → still denied.
- Direct protected URL: logged out → denied; login → allowed.
- Business context: business user logs in → sets an owned business as active → logout clears the
  active-profile cookie → a fresh login does not inherit the old business context (defaults back to
  personal) → the business context can be re-established.
- Platform Admin and Platform Owner: login works, logout works, a subsequent login works.

All of the above run through the actual route handlers (`createLoginHandler`, `createLogoutHandler`,
`createMeHandler`, `createActiveProfileGetHandler`/`createActiveProfileSetHandler`), not just the
`AuthService` layer directly — the incident was in a cross-cutting dependency every route shares, so
only handler-level tests would have caught it.

## Preserved from PRSprint 10A (verified, not removed)

Visible Sign Out control, mobile authenticated topbar, mobile navigation drawer, current-session
logout, protected-route denial after logout, refresh-remains-logged-out after logout, and
business-context cleanup on logout are all confirmed intact by the re-audit above and by the existing
`src/app/api/auth/logout/route.test.ts` and `src/components/AppNav.test.tsx` suites, both still
passing unmodified.

## Known limitations / follow-up

- The exact underlying Postgres-level cause of the `rate_limit_bucket` write failure (connection
  limit, transient outage, or otherwise) was not retrievable from the one captured log line and
  remains unconfirmed. The fail-open fix restores login/signup availability regardless of this cause,
  but does not fix the underlying storage problem — rate limiting on login/signup will be silently
  ineffective for as long as it persists, since it now fails open rather than blocking. This is an
  acceptable, deliberate tradeoff (see Fix above) but should be tracked as a follow-up infrastructure
  investigation.
- `GET /api/health` reported `"environment":"development"` in production (from `APP_ENV` being unset
  on the Vercel deployment). Observed during this investigation but not conclusively linked to the
  incident; recorded here for visibility, not treated as in-scope to fix under this remediation.

## Acceptance criteria

- Root cause identified with evidence, not assumption.
- PRSprint 10A's logout/mobile-navigation fix fully preserved (verified by its own passing test
  suite).
- Login restored without any PRSprint 10A rollback.
- Mandatory login → logout → login-again regression test added and passing, plus the full required
  test matrix above.
- One full test suite run, lint, and typecheck all clean.
- Merged to master, tracker updated, PRSprint 12 not started.
