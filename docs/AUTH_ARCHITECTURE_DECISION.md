# Auth Architecture Decision

Requested by the Sprint 2 review (ChatGPT/Product Owner, CONDITIONAL PASS) as a precondition for
merge. Companion to `docs/AUTHENTICATION.md` (which records the Sprint 2 implementation and its
flagged decisions) — this document goes deeper specifically on the Supabase Auth question, since
that is what the review conditioned the pass on.

## 1. Why the existing custom authentication model was retained

Sprint 2's own instructions default to Supabase Auth "unless the architecture review identifies a
documented blocker." The review found two, one structural and one incidental:

- **Structural (the real reason):** `user_account` — built in Phase 0, before Sprint 2 — is
  already the foreign-key target of five tables: `personal_profile.user_id`,
  `business_profile.owner_user_id`, `business_staff_member.user_id`, `device_session.user_id`, and
  `audit_event.actor_user_id`. Every one of Sprints 3–20 is planned around that same identity
  shape. Supabase Auth manages its own identity table (`auth.users`, in a separate schema) with its
  own user-creation lifecycle. Deciding *how* `user_account` relates to `auth.users` — replace it
  entirely, shadow it, or FK to it — is a data-model decision with consequences for every table
  every later sprint builds. No entry in `docs/OPEN_DECISIONS.md` had already resolved this. Making
  that call unilaterally, inside a single sprint whose actual scope is "implement auth
  functionality," was judged disproportionate — not because the answer is unknowable (§3 below
  answers it), but because it's a decision for the Product Owner to make deliberately, not one to
  fall out of an implementation sprint by default.
- **Incidental (did not by itself justify the decision):** no live Supabase project or credentials
  exist in this development environment. This alone was explicitly *not* treated as sufficient
  justification — the same is true of `DATABASE_URL` generally, and that didn't block building the
  Drizzle schema/migrations in Phase 0 or Sprint 1 against an interface with a real implementation
  ready to go.
- **Supporting factor:** the custom auth code Phase 0 had already built (scrypt+pepper password
  hashing, timing-safe comparison, hashed-session-token storage, audit-logged flows) was reviewed
  and found sound — see `docs/AUTHENTICATION.md`'s component-by-component table. There was no
  existing defect in the custom implementation forcing a platform change; Sprint 2's job was to
  *extend* it (email verification, password reset, MFA, account-disabled handling), which it did.

## 2. How this relates to Supabase as the approved backend platform

There is no conflict, because the custom auth model and "Supabase as backend platform" operate at
different layers:

- **What "Supabase" means in this codebase today:** a Postgres *hosting platform*, reached through
  a standard `postgres://` connection string (`DATABASE_URL`) via Drizzle ORM
  (`src/db/client.ts`). No `supabase-js` client SDK is used anywhere in this repository, and no
  `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` exist. This was
  already the established pattern before Sprint 2 (see `docs/ENVIRONMENT_VARIABLES.md`'s
  architecture note from Sprint 1) — Sprint 2 continued it rather than introducing a new pattern.
- **What "Supabase Auth" would mean:** adopting Supabase's *identity/authentication product*
  specifically — its `auth.users` table, its GoTrue-based session/JWT model, and (typically) the
  `supabase-js` client for sign-in flows. That is a distinct, larger decision than "use Supabase's
  Postgres," and is the thing this session declined to adopt without review.
- **Defense in depth already aligned with Supabase either way:** every identity/auth table has
  `.enableRLS()` plus an explicit `REVOKE ALL ... FROM anon, authenticated` (see
  `src/db/schema/identity.ts`, `src/db/schema/auth.ts`, and the migrations). This protects against
  Supabase's auto-generated PostgREST API surface regardless of which identity model is chosen —
  it was written defensively for the Supabase-hosted case from the start, even though this
  codebase's own server-side code never uses that surface.

In short: the custom auth *decision* only concerns who issues and validates sessions/passwords.
The database Supabase hosts, and the RLS discipline applied to it, are unaffected by that decision
either way.

## 3. Can Supabase Auth still be adopted later without breaking user_account, personal profiles, business profiles, agreement foreign keys, or audit history?

**Yes — conditionally, and the condition is identifiable and manageable.** This is the central
technical finding of this document.

Every foreign key in the current schema points to `user_account.id` (a plain `uuid`), never to
anything Supabase-specific:

```
personal_profile.user_id          -> user_account.id
business_profile.owner_user_id    -> user_account.id
business_staff_member.user_id     -> user_account.id
device_session.user_id            -> user_account.id
audit_event.actor_user_id         -> user_account.id
email_verification_token.user_id  -> user_account.id   (Sprint 2)
password_reset_token.user_id      -> user_account.id   (Sprint 2)
mfa_credential.user_id            -> user_account.id   (Sprint 2)
mfa_challenge.user_id             -> user_account.id   (Sprint 2)
```

No table anywhere FKs to a Supabase-specific `auth.users` row, because no such table is in use.
This means the *shape* of every dependent table (personal profiles, business profiles, and — once
Sprint 5 builds them — agreement tables, which will follow the same pattern every other sprint has)
is completely insulated from the identity-provider decision, **provided one condition holds:**

> **The value of `user_account.id` for every existing user must not change during a future
> migration to Supabase Auth.**

This is achievable. Supabase's standard, documented pattern for exactly this situation is a
"shadow profile" table kept in sync with `auth.users` via a Postgres trigger
(`after insert on auth.users`) that creates or links a corresponding `public` row — and Supabase's
admin API allows *specifying* the UUID when creating an `auth.users` entry, rather than only
letting Supabase generate one. That means existing `user_account.id` values can be preserved
exactly, rather than regenerated, during a future cutover. Under that approach:

- **`user_account`**: not broken — becomes the "shadow profile" table Supabase's own pattern
  expects, keyed by the *same* ids it already has.
- **`personal_profile` / `business_profile`**: not broken at all — their FKs never need to change,
  since they point to `user_account.id`, which doesn't change.
- **Agreement foreign keys** (not yet built — Sprint 5+): not broken, by construction — every
  future sprint's tables are expected to FK to `user_account.id` / `personal_profile.id` /
  `business_profile.id` the same way every existing table does, so there is nothing
  Supabase-Auth-specific for them to depend on in the first place.
- **Audit history** (`audit_event.actor_user_id`): not broken — existing audit rows keep
  referencing the same `user_account.id` values, which remain valid and stable.

**What would *not* survive unchanged**, and is the real cost of adopting Supabase Auth later:

- `user_account.auth_credential_ref` (the scrypt hash reference) becomes meaningless for
  Supabase-Auth-managed users, since Supabase manages its own password storage internally and a
  scrypt hash cannot be converted into Supabase's internal format. Existing users need a
  credential-migration strategy (§4).
- `device_session` (custom session-token-hash table) would be superseded by Supabase's JWT-based
  session model for any user migrated to Supabase Auth. It does not need to be deleted (it could
  remain as a device/audit log), but it would stop being the source of truth for session validity
  for migrated users.
- `mfa_credential` / `mfa_challenge` / `step_up_verification` (Sprint 2's custom MFA) would need a
  decision: migrate to Supabase Auth's built-in MFA, or keep the custom step-up layer running
  alongside Supabase-issued sessions. Both are workable; neither is forced by the data model.

## 4. Migration path if Supabase Auth is adopted later

1. **Enable Supabase Auth on the project**, with `supabase-js` added as a new dependency (not
   present today).
2. **Add a sync trigger**: `after insert on auth.users`, upsert a corresponding `user_account` row
   using the *same* `id`. New signups now create both an `auth.users` row and a `user_account` row
   with matching ids, atomically.
3. **Backfill existing users**: for each existing `user_account` row, create a matching
   `auth.users` entry via Supabase's admin API, explicitly passing the existing `user_account.id`
   as the new user's id, so no FK anywhere needs to change.
4. **Credential cutover**: scrypt hashes cannot be imported into Supabase Auth. The practical path
   is to force a password reset for migrated users — conveniently, Sprint 2 already built a
   password-reset flow (single-use hashed token, email delivery, full session invalidation) that
   can be reused or adapted to prompt affected users to set a new password recognized by Supabase
   Auth, rather than building a new mechanism for this purpose.
5. **Cut over the write path**: update the signup/login/logout endpoints to call Supabase Auth
   (via `supabase-js` or its REST API) instead of `AuthService`'s custom methods.
   `AuthService.validateSession` is replaced or wrapped to validate Supabase's session JWT instead
   of the custom `device_session` token — this is the one place with real code churn, isolated to
   the auth layer itself (`src/lib/auth/*`), not to any table this document has already shown is
   unaffected.
6. **Decide on MFA**: adopt Supabase Auth's built-in MFA, or keep `mfaService.ts`/`requireStepUp`
   running against Supabase-issued sessions (the `sessionId` it keys off can be swapped for
   whatever Supabase's session identifier is).
7. **Retire now-unused custom infrastructure** once no legacy custom sessions remain valid:
   `password.ts`'s hashing code, and `device_session` if not repurposed as a device log.

Every step above is confined to the identity/session layer (`user_account`'s auth-specific columns,
`device_session`, and `src/lib/auth/*`). Nothing in this plan requires touching
`personal_profile`, `business_profile`, `business_staff_member`, `custom_role`,
`beneficial_owner`, or `audit_event`, or any future agreement table — confirming §3's finding in
migration-plan form, not just schema form.

## 5. Security risks of retaining custom auth

- **Ongoing maintenance burden.** Every future vulnerability class (session-fixation variants,
  password-reset-token leakage patterns, credential-stuffing mitigations) must be identified and
  patched by this team, rather than inherited from a managed provider's continuous security
  investment and broader ecosystem scrutiny.
- **No breach-intelligence integration.** There is no leaked-password check (e.g. an
  haveibeenpwned-style lookup) on signup or password reset — a feature some managed identity
  providers offer out of the box.
- **TOTP secrets stored in plaintext** (`mfa_credential.secret_ref`) — already flagged in
  `docs/AUTHENTICATION.md` §5 as a pre-production requirement. A managed provider would typically
  handle this internally with KMS-backed encryption; here it is this team's unaddressed
  responsibility.
- **No passkey/WebAuthn support** (deliberately deferred, `docs/AUTHENTICATION.md` §4) — building
  it later requires vetting and integrating a WebAuthn library ourselves.
- **No independent third-party audit surface.** The custom auth code's security is only as strong
  as this project's own review process; relying on a managed provider provides some indirect
  assurance from that provider's own security audits and track record, which custom code does not
  get "for free."
- **Operational dependency on connection-role discipline.** The RLS defense-in-depth (§2) only
  holds if `DATABASE_URL` is always configured with a role that bypasses RLS appropriately (the
  project-owner/direct-connection role); a misconfiguration here is a silent risk specific to this
  architecture rather than something a managed provider's separation of concerns would prevent by
  default.

## 6. Security controls already implemented to mitigate those risks

- **Password storage**: scrypt (memory-hard KDF), per-user random salt, server-side pepper
  (`AUTH_PASSWORD_PEPPER`) — resistant to offline brute-force even if the database leaks, since the
  pepper is a separate secret not stored in the database.
- **Timing-safe comparison + "unusable hash" trick** on login (`password.ts`,
  `UNUSABLE_PASSWORD_HASH`) — "no such account" and "wrong password" are indistinguishable by
  timing or response shape.
- **Session tokens**: 256-bit random value; only its SHA-256 hash is ever persisted
  (`device_session.session_token_hash`) — a database read alone cannot be replayed as a valid
  session.
- **Cookies**: `httpOnly`, `Secure` in production, `SameSite=Lax` — mitigates XSS token theft and
  cross-site request exposure.
- **Rate limiting**, per-IP and per-account, on signup, login, password-reset request/confirm,
  resend-verification, and MFA enrollment/step-up endpoints.
- **Full audit logging**, hash-chained and tamper-evident (`AuditService`), for every
  auth-relevant event: signup, login success/failure, logout, email verification, password-reset
  request/completion, account-disabled login attempts, MFA enrollment, and step-up pass/fail.
- **Account-disabled enforcement** happens only *after* password verification succeeds, so it adds
  no new account-enumeration signal.
- **Password reset revokes every existing session** for the account (`revokeAllForUser`), not just
  future ones — closes the window where a stolen session could survive a password change.
- **Single-use, hashed, time-limited tokens** for email verification (24h) and password reset (1h)
  — no replay after consumption or expiry.
- **MFA/step-up primitive**: TOTP verified bit-exact against the published RFC 6238 test vector
  (not just internal self-consistency); SMS fallback with per-challenge attempt limits and expiry;
  step-up freshness scoped to the *session* (not just the user), so a step-up on one device cannot
  authorize a different, unverified session; and **no recovery/bypass path exists in the code at
  all** — `requireStepUp` can only return `true` via a real, recent `completeStepUp` call for that
  exact session.
- **RLS enabled with explicit `REVOKE ALL FROM anon, authenticated`** on every identity/auth table
  — defense in depth against Supabase's PostgREST auto-exposure, independent of the identity-model
  decision.
- **Server-side age (18+) enforcement** at signup, not merely a client-side form constraint.

## 7. Can Sprint 3 safely proceed without locking the project into custom auth?

**Yes.** Sprint 3 (Personal & Business Profiles) builds directly on `personal_profile` and
`business_profile`, both of which already FK to `user_account.id` today, and — per §3 — would
continue to FK to `user_account.id` unchanged even if Supabase Auth is adopted later. Proceeding
with Sprint 3 does not deepen any dependency on custom auth specifically: it deepens the
dependency on `user_account.id` as the stable identity key, which is required either way (custom
auth today, or the "shadow profile" pattern under Supabase Auth tomorrow). The identity-provider
decision remains fully reversible at the point Sprint 3 operates — it is a decision about *how
`user_account` rows come to exist and how sessions are issued*, not about *what other tables
reference*.

**Recommendation:** the Supabase Auth question does not need to be resolved before Sprint 3 begins.
It should be resolved before any sprint that materially expands the auth surface again (e.g. if a
sprint were to add social/OAuth login, which is exactly the kind of feature a managed provider
makes cheap and custom code makes expensive) — but nothing in Sprint 3's stated scope depends on
that resolution.

---

**This document does not itself constitute approval to begin Sprint 3.** Per the review's explicit
instruction, Sprint 3 has not been started, and `docs/SPRINT_CONTROL.md` has not been marked
merge-approved. Both remain gated on further Product Owner/ChatGPT direction.
