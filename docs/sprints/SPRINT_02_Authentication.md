Read all PAY2PAY governance and specification documents.

Begin Sprint 2.

GITHUB CI GATE

The current master commit must remain green.

Two historical workflow failures exist on older commits. Do not treat them as
current blockers if the current HEAD workflow passes.

Sprint 2 must be developed on a dedicated branch:

sprint-02-authentication

Do not develop Sprint 2 directly on master.

Before completing Sprint 2:

1. Run the full local verification suite.
2. Commit Sprint 2 changes on the sprint-02-authentication branch.
3. Push that branch to GitHub.
4. Confirm the GitHub CI workflow passes on the Sprint 2 branch/commit.
5. Confirm the Vercel preview deployment for that branch builds successfully.
6. Record the Sprint 2 commit hash and Vercel preview URL in docs/SPRINT_CONTROL.md.
7. If GitHub CI fails, set Sprint 2 status to NEEDS FIX, not COMPLETE.
8. If the Vercel preview build fails, set Sprint 2 status to NEEDS FIX.
9. Do not merge Sprint 2 into master.
10. Do not deploy Sprint 2 to production.
11. Do not begin Sprint 3.

At completion, stop and report:

Awaiting ChatGPT/Product Owner sprint review. I will not begin the next sprint.

SPRINT 2 OBJECTIVE:
Implement secure authentication and the user-account foundation using Supabase as
the approved backend platform.

First review the authentication code previously added during Phase 0.

Do not blindly retain or replace it.

For each existing authentication component:
- identify purpose;
- identify whether it matches the current architecture;
- identify security concerns;
- retain, refactor, or replace deliberately.

Required functionality:

1. User signup
2. Email verification
3. Login
4. Logout
5. Password reset
6. Session persistence
7. Session revocation
8. Secure server-side route authorization
9. Account-disabled state
10. Last-login tracking where appropriate
11. Age eligibility: 18+
12. Basic security-event logging

Use Supabase Auth unless the architecture review identifies a documented blocker.

Do not create competing authentication systems unnecessarily.

MULTIFACTOR / STEP-UP AUTHENTICATION

Sprint 2 owns MFA/step-up authentication infrastructure, required by the master specification for:
signing an agreement, changing a bank account, changing a debit card, changing payout details,
approving settlements, forgiving debt, changing staff permissions, changing business ownership
data, exporting sensitive records, closing accounts, and resetting security credentials.

Implement:

- passkey enrollment (preferred)
- authenticator-app (TOTP) enrollment (preferred)
- SMS fallback only — never the preferred high-assurance method
- an MFA challenge primitive other sprints call before a sensitive action: `requireStepUp(user,
  action)`, returning pass/fail, callable server-side only
- step-up session freshness (a completed challenge is valid for a short, configurable window, not
  indefinitely)
- enrollment required before any sensitive action listed above becomes available; block the action
  with a clear enrollment prompt if the user has no MFA method enrolled
- recovery-method handling that does not silently bypass step-up (no "forgot MFA" path that skips
  verification)

This sprint builds the primitive only. Sprints 4, 6, and 15 call `requireStepUp` for their
respective sensitive actions (staff-permission/threshold changes, signing, settlement approval)
rather than re-implementing MFA — see those sprints' updated text.

Account architecture:

User
  -> one personal profile
  -> zero or more business profiles

Implement only the base profile model needed to establish this relationship.

Do not yet build full business staff permissions.

Security requirements:

- No plaintext passwords
- No service-role key on client
- No authorization based solely on client-provided user IDs
- Validate Supabase sessions server-side
- CSRF protections where relevant
- Login/signup rate limiting
- Account enumeration resistance
- Secure cookies where used
- Session invalidation on logout
- Proper redirects for unauthorized users

Database:

Create migrations for the approved user/profile entities.

Apply RLS.

Create tests proving:

- User A cannot read User B personal profile.
- User A cannot read User B business profile.
- User cannot create a personal profile for another authenticated user.
- Unauthorized user cannot access protected dashboard data.

UI:

Implement functional but restrained:
- Sign Up
- Sign In
- Forgot Password
- Email Verification
- Basic Account Dashboard

Cursor will perform later visual refinement.

Do not spend the sprint redesigning the marketing page.

Testing:

- signup
- verification
- login
- incorrect password
- logout
- reset
- session persistence
- session revocation
- protected routes
- under-18 rejection
- cross-account isolation
- passkey enrollment
- authenticator-app enrollment
- SMS fallback only used when no other method enrolled
- sensitive action blocked with no MFA enrolled
- step-up challenge required and enforced server-side
- step-up session expires and is re-required after the freshness window
- no recovery path bypasses step-up silently

Run:
npm run lint
npm run typecheck
npm test
npm run build

Document:
docs/AUTHENTICATION.md

Update:
docs/PROGRESS.md

Stop after Sprint 2.