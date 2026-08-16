# Authentication (Sprint 2)

Source: `docs/sprints/SPRINT_02_Authentication.md`. This document records the architecture review
required at the start of Sprint 2, the resulting decisions, what was built, and what remains an
explicit gap for future review — not a design document written in advance of the code.

## 1. Architecture review: retain, refactor, or replace?

Sprint 2 requires reviewing Phase 0's existing authentication code component-by-component before
deciding to retain, refactor, or replace it, and requires using Supabase Auth "unless the
architecture review identifies a documented blocker."

| Component | Purpose | Fit with current architecture | Security concerns | Decision |
|---|---|---|---|---|
| `src/lib/auth/password.ts` | scrypt password hashing, peppered, timing-safe verify | Sound, no live-DB dependency | None found — salted, peppered, timing-safe comparison, tunable KDF params stored alongside the hash | **Retain** |
| `src/lib/auth/session.ts` | Random session token + SHA-256 hash storage | Sound | Raw token never persisted, only its hash — mirrors the audit hash-chain's store-a-derivative pattern | **Retain** |
| `src/lib/auth/authService.ts` | Signup/login/logout/session orchestration | Central orchestration point, already audit-logged | Account-enumeration resistance already present (unusable-hash timing trick); **did not** yet check `user_account.status`, track last login, verify email, or support password reset | **Retain, refactor** — extended in place (see §3) rather than replaced |
| `src/app/api/auth/{signup,login,logout,me}/route.ts` | HTTP boundary: validation, rate limiting, cookies | Consistent `withErrorHandling` + factory-for-testability pattern already established | Rate limiting and account-enumeration resistance already present | **Retain, refactor** — signup route gained a `dateOfBirth` field |
| `src/lib/auth/cookies.ts` | httpOnly/secure/sameSite session cookie | Sound | None found | **Retain** |
| MFA / step-up | — | Did not exist | — | **New** (§4) |
| Email verification, password reset | — | Did not exist | — | **New** (§3) |

### Supabase Auth: documented blocker

The sprint text defaults to Supabase Auth. This session did **not** adopt it, for a specific,
documented reason rather than convenience:

**Blocker:** `user_account` (Phase 0) is already the foreign-key target of five migrated tables —
`personal_profile.user_id`, `business_profile.owner_user_id`, `business_staff_member.user_id`,
`device_session.user_id`, and `audit_event.actor_user_id` — and every future sprint (3–20) is
planned around that same identity shape. Supabase Auth manages its own `auth.users` table in a
separate schema; adopting it now would require deciding how `user_account` relates to `auth.users`
(replace it? shadow it? FK to it?) — a data-model redesign with no existing entry in
`docs/OPEN_DECISIONS.md`, decided unreviewed inside a single sprint, with consequences for every
table every later sprint builds. This is a materially different kind of change than "swap a
library" and was judged out of proportion to Sprint 2's own scope.

Secondary factor, not the primary reason: no live Supabase project or credentials exist in this
environment (the same is true of `DATABASE_URL` generally, and that alone did not block building
the Drizzle schema/migrations in Phase 0 or Sprint 1 — so this alone would not have been sufficient
justification without the data-model concern above).

**This is flagged for explicit Product Owner / ChatGPT review** — it is the single largest
divergence from the sprint's literal default in this session's work.

## 2. Account architecture

```
user_account (Phase 0, extended)
  -> exactly one personal_profile   (created at signup, never client-specified — see §3)
  -> zero or more business_profile  (not built this sprint — Sprint 3's scope)
```

`user_account` gained two columns this sprint: `email_verified_at` (nullable timestamp) and
`last_login_at` (nullable timestamp). `date_of_birth` (already present, previously commented as
"captured at Full verification") is now captured **at signup**, since age eligibility must be
checked before an account exists at all — the column is reused, not duplicated.

## 3. Auth flows

- **Signup** (`POST /api/auth/signup`): email, password (8–256 chars), date of birth. Rejects
  under-18 signups (`AuthService.signup`, age computed server-side — the client `<input type="date">`
  is a UX affordance, not the enforcement point). Creates `user_account` + `personal_profile`,
  sends a verification email, and returns an authenticated session (login before verification is
  allowed by design — see below).
- **Email verification** (`GET/POST` via `/verify-email?token=...` page → `POST
  /api/auth/verify-email`): single-use, SHA-256-hashed, 24-hour token. `POST
  /api/auth/resend-verification` is authenticated (not a public email-lookup endpoint — no
  enumeration surface) and rate-limited per account.
- **Design choice, not required by the sprint text:** login is allowed before email verification
  (common practice; `email_verified_at` is exposed so a later sprint can gate specific actions on
  it). Flagged here since the alternative (block login until verified) is equally defensible.
- **Login** (`POST /api/auth/login`): unchanged account-enumeration-resistant password check, now
  also rejects `status !== "active"` accounts with a dedicated `AccountDisabledError` (403) — safe
  to be specific only because it's reached *after* a correct password, so it adds no enumeration
  signal. Updates `last_login_at` on success.
- **Password reset** (`POST /api/auth/password-reset/request` → email link → `POST
  /api/auth/password-reset/confirm`): the request endpoint always returns the identical response
  whether or not the email exists (enumeration resistance). A successful reset revokes every
  existing session for that account (`SessionRepository.revokeAllForUser`), not just future ones.
- **Logout / session validation**: unchanged from Phase 0.

## 4. MFA / step-up (`src/lib/auth/mfaService.ts`)

Sprint 2's required primitive: `requireStepUp({ userId, sessionId, action })`, called by future
sprints (4, 6, 15 per their own updated text) before a sensitive action — this sprint builds and
tests the primitive, not its callers.

- **TOTP (authenticator app)** — fully implemented using only `node:crypto` (RFC 6238), verified
  bit-exact against the **published RFC 6238 Appendix B test vector**
  (`src/lib/auth/totp.test.ts`), not just self-consistency — this is what actually matters for
  interoperating with real apps (Google Authenticator, Authy, 1Password, etc.).
- **SMS (fallback)** — 6-digit codes, hashed at rest, rate-limited attempts (5 per challenge before
  lockout), 5-minute expiry.
- **Passkey (WebAuthn) — deliberately NOT implemented this sprint.** The master spec lists
  passkeys, authenticator apps, and hardware-backed methods as *preferred*, not each individually
  mandatory. Implementing WebAuthn correctly requires verifying cryptographic
  attestation/assertion signatures — a meaningfully different risk profile from TOTP's small,
  published, test-vector-verifiable algorithm. Rolling that verification by hand in the same
  session as everything else in this document was judged too high-risk; the standard path is a
  vetted library (e.g. `@simplewebauthn/server`), which is a real dependency addition and its own
  client-side ceremony, better done as its own reviewed unit of work. `"passkey"` remains reserved
  in the `mfa_method` enum so adding it later needs no migration. **Flagged for Product Owner
  review** as the second-largest scope decision in this session.
- **Step-up freshness**: scoped to the *session*, not just the user (`step_up_verification.session_id`),
  for a 15-minute window by default — a step-up completed on one device does not authorize a
  sensitive action from a different, unverified session (tested).
- **No bypass path**: there is no "forgot MFA" / recovery endpoint anywhere in this codebase.
  `requireStepUp` returns `false` — never throws, never defaults to permissive — whenever the user
  has no verified method enrolled or no fresh step-up exists. This is structural (no code path
  exists to skip it), not a runtime check that could have a bug in it.

## 5. Known gaps, flagged deliberately rather than silently accepted

1. **Supabase Auth not adopted** — see §1. Requires a Product Owner/architecture decision, not an
   engineering one, before it can be revisited.
2. **Passkey/WebAuthn not implemented** — see §4.
3. **TOTP secret storage is plaintext** (`mfa_credential.secret_ref`). This project has no
   field-level encryption/KMS infrastructure yet; this follows the same already-accepted Phase 0
   convention as `business_profile.ein_or_ssn_ref` ("tokenized/encrypted reference, never raw" —
   aspirational comment, not yet implemented) rather than inventing a new, inconsistent standard
   unreviewed. **Must be addressed** (application-level envelope encryption or a secrets-manager
   reference) before any production credential relies on it.
4. **No real email or SMS provider is integrated** (`src/lib/notify/console{Email,Sms}Sender.ts`
   log instead of deliver). Standing up a production provider is explicitly Sprint 17's scope
   (`docs/sprints/SPRINT_17_Notifications.md`), not Sprint 2's — building it here would preempt
   that sprint's ownership. The token/code *lifecycle* (generation, hashing, expiry, single-use,
   attempt limits) is fully built and tested against these interfaces; swapping in a real sender
   requires no other code change.
5. **RLS policies added, unverified against a live database.** Every new/touched table
   (`user_account`, `personal_profile`, `business_profile`, `business_staff_member`, `custom_role`,
   `device_session`, `beneficial_owner`, plus the five new Sprint 2 tables) has `.enableRLS()` with
   no permissive policy for `anon`/`authenticated` — same pattern as Sprint 1's
   `early_access_leads`. No live Postgres/Supabase instance exists in this environment to actually
   run the migration against, consistent with every prior phase of this project.

## 6. API surface added this sprint

`POST /api/auth/verify-email`, `POST /api/auth/resend-verification`, `POST
/api/auth/password-reset/request`, `POST /api/auth/password-reset/confirm`, `POST
/api/auth/mfa/totp/enroll`, `POST /api/auth/mfa/totp/confirm`, `POST /api/auth/mfa/sms/enroll`,
`POST /api/auth/mfa/sms/confirm`, `POST /api/auth/mfa/step-up/initiate`, `POST
/api/auth/mfa/step-up/verify`, `GET /api/account/dashboard`. Pages: `/signup`, `/login`,
`/forgot-password`, `/reset-password`, `/verify-email`, `/account`.

## 7. Testing

164 new/changed tests across `src/lib/auth/*.test.ts` (`authService`, `mfaService`, `totp`,
`crossAccountIsolation`) and one `route.test.ts` per new/changed API route, all against in-memory
repository fakes (no live database in this environment — consistent with every prior phase).
Covers every item in the sprint's required test list: signup, verification, login, incorrect
password, logout, reset, session persistence, session revocation, protected routes, under-18
rejection, cross-account isolation, TOTP enrollment, SMS-fallback-only-when-nothing-else-enrolled,
sensitive-action-blocked-with-no-MFA, server-enforced step-up, step-up expiry, and no-silent-bypass.

## 8. PRSprint 06 additions (Authentication & Session Hardening)

`docs/prsprints/PRSPRINT_06_AUTHENTICATION_SESSION_HARDENING.md`. Reviewed everything built above
against that PRSprint's scope (signup/login/logout/session persistence, expiration, single-use
expiring password reset, enumeration protection, session revocation/logout-all, device/session
visibility, MFA/step-up for high-risk actions, secure cookie settings) and Sprint 18C
production-readiness requirements 40–42 and 110–112. Most of that scope was already built and
tested in Sprint 2/6A/18B (see §§3–4 and 6 above, plus §5's already-tracked gaps) and needed no
further change here. Two concrete, previously-untested gaps were closed:

1. **Device/session visibility + self-service revocation ("log out everywhere") — was entirely
   unbuilt.** `AccountSecurity.tsx`'s own doc comment previously flagged this explicitly: the
   `SessionRepository` interface had no list-by-user method, only
   `findByTokenHash`/`insert`/`revoke`/`revokeAllForUser`. Added `listActiveForUser(userId, now)`
   and `findById(id)` to the repository interface (implemented in both
   `DrizzleSessionRepository` and the in-memory test fake), and three new `AuthService` methods —
   `listSessions`, `revokeSession` (ownership-checked; throws the same `AuthenticationError` for
   "not found" and "belongs to someone else," so an IDOR guess gets no distinguishing signal, the
   same enumeration-resistance pattern login already uses), and `revokeAllSessions` ("log out
   everywhere," including the session that made the request). New self-service API surface: `GET
   /api/account/sessions`, `POST /api/account/sessions/revoke`, `POST
   /api/account/sessions/logout-all`. The Security page's "Signed-in devices" card now lists real
   sessions (device/IP/last-active, current-device badge) with per-session revoke and a "log out
   of all devices" action, replacing the placeholder text.
2. **Three high-risk admin actions had no step-up requirement, unlike role-change and
   impersonation-start.** `AdminService.suspendUser`, `reactivateUser`, and `revokeUserSessions`
   (disabling/re-enabling an account and forcibly signing someone out) previously required only
   platform-admin/owner authorization, no fresh MFA step-up — inconsistent with `changeUserRole`
   and `startImpersonation`, which already did, and with requirement 40/111's "high-risk
   operations... stronger authentication" and "Platform Owner account... MFA." Extracted the
   existing step-up check into a shared `requireFreshStepUp` helper and applied it to all five
   sensitive `AdminService` mutations uniformly.

**Reviewed, deliberately not changed:** session "refresh"/sliding expiration was reviewed and
intentionally left as a fixed 30-day absolute TTL (`SESSION_TTL_MS`) rather than adding
silent-extension-on-activity — `device_session.last_seen_at` already gives visibility into recency
without weakening the hard expiry, and a sliding window would need every one of this app's ~170
authenticated routes to reissue a cookie, a materially larger and riskier change than this
PRSprint's other items. Cookie settings (`httpOnly`, `secure` outside development, `sameSite:
"lax"`) were re-reviewed against requirement 138/142 and found already correct, unchanged since
Sprint 2. "No shared admin credentials" (requirement 112) is satisfied by construction, not a new
check: every admin action already re-derives its actor from the trusted, DB-sourced session
identity (never a client-supplied value), there is no generic/shared admin login path anywhere in
this codebase, and every audit record already carries the real `actorUserId`.

## 9. API surface added this PRSprint

`GET /api/account/sessions`, `POST /api/account/sessions/revoke`, `POST
/api/account/sessions/logout-all`.
