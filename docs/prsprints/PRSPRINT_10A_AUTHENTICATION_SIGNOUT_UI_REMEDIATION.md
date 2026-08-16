# PRSprint 10A — Authentication Sign-Out UI Remediation

**Path:** `docs/prsprints/PRSPRINT_10A_AUTHENTICATION_SIGNOUT_UI_REMEDIATION.md`
**Program:** PAY2PAY Production Ready Sprints
**Execution Mode:** One PRSprint only. Out-of-sequence remediation — inserted between PRSprint 10 and PRSprint 11.

## Goal

A normal authenticated user does not currently have a reliable, clearly accessible Sign Out / Log Out capability in the deployed Paid2You application. This PRSprint audits and corrects the complete current-session logout experience.

## Source Defect

A production-readiness authentication defect has been identified: a reliable, clearly accessible Sign Out / Log Out control could not be found or reliably used in the deployed application. PRSprint 06 previously verified authentication/session hardening architecture (step-up, session listing/revocation primitives), but the actual end-to-end current-session logout *experience* was not independently verified end-to-end.

## Mandatory Execution Rules

1. Read this file completely before changing code.
2. Also read `CLAUDE.md`, `docs/prsprints/PRSPRINT_PROGRAM.md`, `docs/prsprints/PRSPRINT_CONTROL.md`, and PRSprint 06's completion record (row 06 of `PRSPRINT_CONTROL.md`) and `docs/AUTHENTICATION.md`.
3. Execute **this PRSprint only**. Do not begin PRSprint 11.
4. Inspect actual code and deployment configuration; do not infer completion from documentation alone.
5. Do not silently defer, downgrade, or hide findings.
6. All database changes must use controlled migrations.
7. All authorization/session changes require negative tests.
8. Never expose secrets, credentials, passwords, CVV, PIN, raw banking credentials, or sensitive authentication data.
9. Stop for ChatGPT/Product Owner review at completion.

## Root Cause Categories to Determine

1. Sign Out never implemented in UI
2. UI removed/regressed
3. Hidden or unreachable control
4. Frontend not connected to backend logout
5. Logout exists only for some account types
6. Session invalidation defect
7. Navigation/account-menu defect

## Required Scope

1. **Root cause.** Determine which of the categories above (or a combination) explains the defect, by reading the actual UI/routing/session code — not by assuming.
2. **Separate concerns.** Verify normal current-session Sign Out is distinct from, and not confused with:
   - Log Out Everywhere
   - Revoke All Sessions
   - business-context switching
3. **Visible control.** Provide a clearly visible Sign Out control for every applicable account type:
   - individual users
   - business users/staff
   - business administrators
   - Platform Administrators
   - Platform Owner
4. **Current-session logout verification.** Confirm Sign Out:
   - terminates/invalidates the current authenticated session
   - clears applicable authentication cookies/tokens
   - clears sensitive client/user state
   - redirects to an appropriate public/login page
   - prevents protected-route access afterward
   - remains logged out after a page refresh
   - browser Back does not restore usable authenticated access
   - direct entry of a protected URL is denied/redirected
5. **Context leakage.** Verify business/account context cannot expose protected information after logout.
6. **Regression tests.** Add automated tests covering:
   - Login -> Sign Out -> Back -> protected route denied
   - Login -> Sign Out -> Refresh -> remains logged out
   - Login -> copy protected URL -> Sign Out -> paste URL -> denied

## Required Implementation Record

Document:
- root cause;
- files changed;
- database/schema/migrations changed (if any);
- API/server actions changed;
- UI routes/components changed;
- tests added/changed;
- security implications;
- rollback/forward-fix plan;
- unresolved blockers.

## Required Verification

Run all applicable checks:
- lint;
- typecheck;
- targeted unit/integration tests;
- the three required regression scenarios above;
- build;
- manual workflow verification;
- Vercel preview verification when relevant.

A compile/build alone is never sufficient evidence of PASS.

## Execution Rules (optimized)

- Targeted audit only — inspect the actual auth/session/nav code paths, not a full-codebase sweep.
- Targeted tests during implementation; one full test-suite run as final local verification.
- No unnecessary background agents.
- No duplicate lint/typecheck/build passes.
- Automatic push -> PR -> CI -> merge -> master sync.

## Acceptance Criteria

- [ ] Root cause is identified and documented from actual code inspection
- [ ] A clearly visible Sign Out control exists for every applicable account type
- [ ] Sign Out is verified distinct from Log Out Everywhere / Revoke All Sessions / business-context switching
- [ ] Current-session termination, cookie/state clearing, redirect, and protected-route denial are all verified
- [ ] Refresh-after-logout and browser-Back-after-logout are both verified safe
- [ ] Direct entry of a protected URL after logout is denied/redirected
- [ ] Business/account context does not leak protected information after logout
- [ ] The three required regression scenarios are covered by automated tests and pass
- [ ] No new unresolved CRITICAL/HIGH security defect is introduced

## Hard Stop / Escalation Rule

Stop and escalate if this PRSprint discovers a new CRITICAL security or authorization defect (e.g., a session that cannot be terminated server-side, or protected data reachable after logout).

## Required Completion Report

Report:
1. root cause;
2. exact files changed;
3. verification results for each required check;
4. automated tests added;
5. manual verification;
6. deployment/Vercel status;
7. known limitations;
8. Git branch/commit/PR status;
9. acceptance-criteria result.

## Required Final Response

```text
PRSPRINT 10A COMPLETE
Status: PASS/PARTIAL/FAIL
Root cause:
Sign Out UI: PASS/FAIL
Current-session termination: PASS/FAIL
Protected-route denial after logout: PASS/FAIL
Refresh remains logged out: PASS/FAIL
Browser Back protection: PASS/FAIL
Individual account: PASS/FAIL
Business account: PASS/FAIL
Admin account: PASS/FAIL
Tests: PASS/FAIL
CI: PASS/FAIL
Vercel: PASS/FAIL
Merge: MERGED/NOT MERGED
Master synchronized: YES/NO
Product Owner Review: PENDING
PRSprint 11 has NOT been started.
Awaiting ChatGPT/Product Owner PRSprint review.
```
