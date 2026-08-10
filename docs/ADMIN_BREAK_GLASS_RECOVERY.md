# Platform Owner break-glass recovery

Source requirement: `docs/sprints/SPRINT_06A_Platform_Administration_Audit_Control.md`, "Break-Glass
Recovery." This document is the entirety of that requirement's deliverable — there is deliberately
**no application code** implementing an in-app override, recovery route, master password, or bypass
account. The sprint's own text is explicit that none of those may exist:

> Do NOT create: Hidden URLs · Master passwords · Hard-coded admin credentials · Secret query
> parameters · Universal bypass accounts · Undocumented database bypasses

## Why recovery has no in-app path

Every `platform_owner` capability implemented in Sprint 6A (`src/lib/admin/adminService.ts`) is
reachable only by a user who already holds the `platform_owner` role. There is intentionally no
"first owner" bootstrap endpoint, no self-promotion path, and no route that can create or restore a
`platform_owner` — `AdminService.changeUserRole` only supports `member` ↔ `platform_admin`
transitions and explicitly refuses to touch any account whose current role is `platform_owner` (see
that method's doc comment). This is a deliberate design choice: **the only way to change who holds
`platform_owner` is direct database access**, not a feature of the running application.

## The recovery procedure

If platform ownership is ever lost (the sole owner account is inaccessible, compromised, or its
credentials are lost) or must be transferred:

1. **Verify infrastructure ownership first.** Recovery requires direct access to this project's
   database (via its hosting provider's own account-recovery process) — the same infrastructure
   credential that already gates every other irreversible operation on this project (schema
   migrations, environment-variable changes, deployment). Whoever can authenticate to the database
   host as its owner is who "owns" this recovery procedure; the application itself has no separate
   notion of ownership to verify.
2. **Restore access via direct SQL, not the application.** With verified infrastructure access, run
   a single, logged, manually-executed statement against `user_account` to set
   `platform_role = 'platform_owner'` for the intended account (identified by its known email).
   This is intentionally outside the app's request/response path — it cannot be triggered by any
   API call, and no application code path exists to do it for you.
3. **Record the incident.** Because this bypasses `AdminService` entirely, no `audit_event` row is
   generated automatically. Whoever performs the recovery must manually record, outside the
   database (e.g. in an incident log kept alongside this document): the date/time, who performed
   the recovery, why it was necessary, and which account was restored/granted. This is the
   documented incident record the sprint requires — since the database-level action itself cannot
   populate the application's own append-only audit trail, the incident log is the audit trail for
   this one operation.
4. **Rotate credentials that may have been exposed.** If the recovery was prompted by a suspected
   compromise (not just an ordinary lost-access situation), rotate: the recovered account's
   password (`POST /api/auth/password-reset/request` from a trusted starting point, or a direct
   database credential-reference update), `AUDIT_HASH_SECRET` and `AUTH_PASSWORD_PEPPER` if there is
   any reason to believe they were exposed (note: rotating `AUDIT_HASH_SECRET` breaks the ability to
   re-verify the hash chain of audit events recorded *before* rotation against a *newly computed*
   hash using the new secret — old chain segments remain internally self-consistent among
   themselves under the old secret, but the app has no dual-secret verification mode; this is a
   known limitation, not addressed by this sprint), and the database host account credential used to
   perform step 2.
5. **Confirm normal operation.** Sign in as the restored/granted owner through the ordinary login
   flow (`POST /api/auth/login`) — not through anything special — and confirm `/api/admin/whoami`
   reports `platform_owner`. From this point forward, all further administrative action goes back
   through the normal, audited `AdminService` paths.

## What this procedure deliberately does not do

- It does not create a standing "recovery mode" or feature flag in the application.
- It does not let a `platform_admin` account promote itself or anyone else to `platform_owner` —
  that capability does not exist anywhere in the codebase.
- It does not touch `agreement`, `agreement_version`, `signature_event`, or `agreement_pdf` — none
  of those tables are relevant to platform-owner recovery, and this procedure must never be used as
  a pretext to modify them (see `docs/SPRINT_CONTROL.md`'s Sprint 6A notes for the separate,
  explicit guarantee that no admin path — recovery included — can alter signed agreement records).
