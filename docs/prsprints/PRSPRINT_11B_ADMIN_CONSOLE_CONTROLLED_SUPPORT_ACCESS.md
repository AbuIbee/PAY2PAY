# PRSprint 11B: Admin Console & Controlled Support Access

## Trigger

After PRSprint 11A's Product Owner approval, a remaining production-readiness gap was flagged: the
platform did not yet provide a complete, usable Admin/Support Console for Platform Owner and Platform
Administrator access. This is an out-of-sequence, urgent remediation sprint, inserted before PRSprint
12 at the Product Owner's explicit direction. PRSprint 12 is NOT started as part of this work.

## Goal

Implement a secure, dedicated administrative interface and controlled support-access architecture —
not an unrestricted backdoor. The admin area enforces existing Platform Owner/Platform Administrator
authorization server-side and is fully audited.

## Targeted audit: what already existed vs. what was actually missing

A large admin console already existed from Sprint 6A and PRSprints 04–07 (`/admin` + 7 sub-pages,
30+ `/api/admin/*` routes, `AdminService` with step-up-gated, reason-required, fully audited
suspend/reactivate/revoke-sessions/role-change and a read-only "View As User" support view). Reading
the actual code (not documentation) found it was substantially complete, with five concrete, provable
gaps closed this PRSprint rather than a rebuild:

1. **The real Users search page was unreachable from navigation.** `AppNav.tsx`'s admin section
   labeled `/admin` as "Users", but `/admin` renders `AdminDashboard` (an overview page) — the actual
   search-by-email/id page (`AdminUsers.tsx`) lives at `/admin/users` and had no nav entry at all,
   reachable only by typing the URL directly. Fixed: `/admin` is now correctly labeled "Dashboard",
   and `/admin/users` ("Users") was added.

2. **No production capability existed to suspend or reactivate a business at all.** `business_profile.status`
   (`active`/`disabled`/`deleted`) existed only as a schema column; `BusinessProfileRepository` had no
   `updateStatus` method, `BusinessProfileService` had no such method, and no admin route or UI touched
   it — `InMemoryBusinessProfileRepository.setStatus` was a test-only helper never backed by any real
   write path. This meant the entire "BUSINESS ADMINISTRATION" requirement (search business, view
   profile/memberships/status, suspend/reactivate, related agreements, business audit) had no backend
   to build a UI against. Added `BusinessProfileRepository.updateStatus`, `AdminBusinessDirectoryReader`
   (search/detail, including owner and active staff memberships), and
   `AdminService.searchBusinesses`/`getBusinessDetail`/`suspendBusiness`/`reactivateBusiness` — the
   same step-up-gated, reason-required, audited pattern as the existing user-admin methods, plus a new
   `/admin/businesses` + `/admin/businesses/detail` UI (mirroring `AdminUsers`/`AdminUserDetail`
   exactly) and 4 new routes.

3. **An admin's support view ("View As User") could become a hidden, persistent session.** The
   read-only impersonation session's id lived only in the one page's React state
   (`AdminUserDetail.tsx`) — a refresh or navigating anywhere else made it invisible to the UI while it
   stayed open (`endedAt: null`) on the server indefinitely, with no way to rediscover or end it, and
   nothing prevented an admin from starting several concurrent ones. This is exactly the "hidden
   persistent support session" this PRSprint's own Goal names as something the architecture must not
   allow. Fixed: added `AdminImpersonationSessionRepository.findActiveForAdmin`; `startImpersonation`
   now refuses a second concurrent session per admin; a new `AdminService.getActiveImpersonation` +
   `GET /api/admin/impersonation/active` lets the UI re-surface an admin's own still-open session; a
   new global `AdminImpersonationBanner`, mounted in the authenticated app shell layout (not on any
   single page), shows "ADMIN SUPPORT VIEW ACTIVE — viewing `<email>` — started `<time>`" with an
   immediate "End support view" control from anywhere in the app, surviving refreshes and navigation.
   `AdminUserDetail.tsx`'s own local control was also updated to restore its state on load.

4. **The audit log UI omitted the target.** `AdminAuditLog.tsx` already searched/filtered by target
   type + id and showed when/action/actor/reason, but did not render the target type/id it was
   filtered on, one of the explicitly required fields ("target", "entity ID"). Added as a column.

5. **Impersonation single-session enforcement had no dedicated test coverage** — added directly (see
   Tests below), alongside a full business-admin authorization matrix and route-level negative-security
   coverage for every new endpoint.

No schema/migration change was needed anywhere in this PRSprint — every gap above was a missing
service/route/UI capability against columns and tables that already existed.

## Deliberately left as-is (with rationale, not silently skipped)

- **Financial/provider support** (payment/transaction status, provider reference IDs, financial
  account status, card status, webhook/provider errors): `AdminLedger.tsx` already covers
  ledger/transaction status, adjustments, reconciliation exceptions, and provider event IDs. No live
  payment/KYC/card provider exists in this codebase yet (confirmed by PRSprint 04's own finding, still
  true) — everything is sandboxed, so there is no live card-status/webhook-error data to build a
  dedicated view against yet. That capability belongs to PRSprints 21–24 (Production Financial
  Provider Architecture / KYC / ACH / Debit Card), once real providers exist to surface.
- **Verified contact information beyond email**: `user_account.phone` exists as a schema column but is
  not populated by any signup/profile flow and is not part of `UserAccountRecord` at all (not plumbed
  through anywhere in the app). Adding it to the admin view would require a broader interface change
  than this remediation's scope, for a field that currently holds no real data. Recorded here rather
  than fabricated.
- **Correlation/request ID and an explicit success/failure "result" field on audit events**: the
  `audit_event` schema has neither column, and audit rows are only ever written on a successful
  action (a failed attempt throws before any audit write) — there genuinely is nothing to surface.
  Adding either is a real schema change belonging to PRSprint 28 (Error Handling, Observability &
  Health Monitoring), not a targeted admin-console remediation.

## Roles preserved (verified, not modified)

Platform Owner (highest authority, owner-only operations, manages Platform Administrators, cannot be
created through ordinary UI/self-promotion), Platform Administrator (broad support capability, cannot
promote self/others to Owner, cannot perform owner-only operations), Business Administrator/Staff
(business-scoped only, no platform administration access) — all pre-existing, re-verified by the full
`adminService.test.ts` suite (including new business-admin authorization tests using the identical
"a plain admin may only act on a Member-owned target, an Owner may act on anyone but another Owner"
rule already established for user targets) and by every negative security test below passing.

## Negative security tests (verified)

- Member → every admin operation (user and business) → DENIED (`ForbiddenError`), at both the
  service layer (`adminService.test.ts`) and the HTTP layer (401 with no session, 403 with a genuine
  Member session, for every new `/api/admin/businesses/*` and `/api/admin/impersonation/active` route).
- Platform Admin → allowed admin functions only; owner-only operations (role change) → DENIED
  (pre-existing, re-verified unchanged).
- Platform Admin → acting on a business owned by another Platform Admin or a Platform Owner → DENIED.
- Platform Admin → acting on a business owned by an ordinary Member → ALLOWED.
- Platform Owner → owner-only operations and acting on any business regardless of owner → ALLOWED.
- Sensitive business actions (suspend/reactivate) → DENIED without a fresh step-up, even for a genuine
  Platform Admin session; ALLOWED once step-up is granted.
- A nonexistent business/user id → a validation error, never a different status that would leak
  existence.
- Direct API request bypassing the UI → same 401/403 enforcement (the routes are the actual
  authorization boundary; the UI's admin-link visibility was never load-bearing, confirmed unchanged).
- Impersonation cannot escalate privileges: still read-only, still never issues a session token for
  the target (pre-existing guarantee, re-verified unchanged) — and now additionally cannot silently
  multiply into several concurrent, undiscoverable sessions.
- Suspended admin loses access / revoked session cannot continue admin activity: new test proves a
  Platform Owner suspending a Platform Admin immediately revokes every one of that admin's existing
  sessions (the identical mechanism already used for suspending a Member, now proven against an admin
  target specifically, since a Platform Owner — unique among actors — may suspend either).

## Protected authentication baseline (PRSprint 11A)

This PRSprint touches `src/components/AppNav.tsx` and `src/app/(app)/layout.tsx`, both files where
PRSprint 11A's protected behavior (visible Sign Out, mobile authenticated topbar/navigation, logout)
lives. Why the change is unavoidable and safe: `AppNav.tsx`'s edit is confined to the `ADMIN_LINKS`
data array (labels/hrefs for the admin nav section) — the mobile topbar markup, the drawer
open/close state, and `handleLogout` are byte-for-byte unchanged. `layout.tsx`'s edit adds one sibling
component (`AdminImpersonationBanner`) next to `<main>`, before `AppNav` and its own markup, changing
nothing about how `AppNav` itself renders. The full PRSprint 11A regression suite
(`src/app/api/auth/login-logout-cycle.test.ts`, `src/lib/rate-limit.test.ts`,
`src/app/api/auth/login/route.test.ts`, `src/app/api/auth/logout/route.test.ts`,
`src/components/AppNav.test.tsx`) was run explicitly before merge: 40/40 passed, including the
mandatory login → logout → login-again regression test, session persistence, and every other
protected scenario.

## Tests

- `src/lib/admin/adminService.test.ts`: 30 tests (12 new) — business-admin authorization matrix,
  step-up enforcement, already-suspended/already-active rejection, audit-event target verification,
  suspended-admin session revocation, single-active-impersonation enforcement and recovery,
  `getActiveImpersonation` for an admin with none / a non-admin caller.
- `src/app/api/admin/businesses/route.test.ts` (new): 11 tests covering search/detail/suspend/
  reactivate at the HTTP layer — 401/403/200, step-up enforcement, nonexistent-id handling, and a full
  suspend→reactivate cycle through the real route handlers.
- `src/app/api/admin/impersonation/active/route.test.ts` (new): 4 tests — 401/403, null when no
  active session, and surfacing a real one.
- Full PRSprint 11A protected-baseline regression suite (see above): 40/40 passed.
- Full suite: 942/942 passed (up from 918 — 24 net new, no regressions).

## Verification

- Targeted admin/auth tests: PASS (see above).
- Full test suite: PASS, 942/942.
- Lint and typecheck: clean.
- No database/schema/migration change — no Supabase verification required this PRSprint.
