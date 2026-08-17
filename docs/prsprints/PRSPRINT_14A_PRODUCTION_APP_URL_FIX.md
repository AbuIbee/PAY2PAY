# PRSprint 14A: Production `APP_URL` Fix

**Trigger:** During PRSprint 14's controlled production email verification, the Product Owner
reported that the received password-reset email's link pointed at `localhost` instead of
`https://paid2you.com`. Out-of-sequence urgent remediation, mirroring PRSprint 11A/12A's identical
precedent — a real production defect found during live verification, fixed before PRSprint 14 can be
marked complete, without starting PRSprint 15.

## Root Cause

`APP_URL` — the single, already-centralized environment variable every link-building service in this
codebase reads via `getServerEnv().APP_URL` (`AuthService`, `StaffService`,
`AgreementInvitationService`, `RelationshipInvitationService`, and — new in PRSprint 14 —
`NotificationService`'s CTA-link builder) — **had never been provisioned in any Vercel environment**
(Production, Preview, or Development). Confirmed directly, not assumed:

```
$ vercel env ls production | grep -i "APP_URL\|NEXT_PUBLIC\|SITE_URL\|BASE_URL"
# (no APP_URL row — only unrelated NEXT_PUBLIC_SUPABASE_* rows)
```

`src/config/env.ts`'s schema defines `APP_URL: z.string().url().default("http://localhost:3000")` — a
deliberate, documented convenience for local development. Because the variable was never set in
Vercel, that development-only default silently activated in production too. `AuthService.
requestPasswordReset` (and every other affected service) built its link exactly as designed —
`${this.options.appUrl}/reset-password?token=...` — the *code path* was never wrong; the *input* to
it was.

**This was not a PRSprint-14-introduced defect.** Every one of the five services listed above has been
reading this same never-configured variable since it was first introduced (Sprint 2/6). It was
invisible before PRSprint 14 because every affected email went through `ConsoleEmailSender`
(log-only, nothing ever actually delivered) — PRSprint 14 wiring up real delivery is what made a
pre-existing, silent misconfiguration visible for the first time, via the Product Owner's own inbox.

## Trace (every affected code path)

`grep -rn "APP_URL" src` confirms six production factory files consume it — all correctly centralized,
none scattered, none deriving a base URL from a per-request value:

| File | Feature |
|---|---|
| `src/lib/auth/getAuthService.ts` | Email verification, password reset |
| `src/lib/staff/getStaffService.ts` | Staff invitations |
| `src/lib/agreementInvitations/getAgreementInvitationService.ts` | Agreement invitations |
| `src/lib/relationships/getRelationshipInvitationService.ts` | Relationship invitations |
| `src/lib/notify/getNotificationService.ts` | Notification CTA links (PRSprint 14) |

All were affected identically and are all fixed by the same single-variable correction — confirming
requirement #3 ("do not hard-code production URLs in scattered application code if an existing
centralized configuration mechanism exists") was already satisfied by this codebase's own design; the
gap was purely in environment provisioning, not code.

**Host-header-substitution check (requirement #7):** `grep -rn 'headers.get("host")\|x-forwarded-host'
src` returns zero matches — no code anywhere derives a link's origin from a client-controlled request
value. Every one of the six services above takes `appUrl` as a constructor-time dependency, sourced
only from `getServerEnv()`. Verified, not assumed.

## Fix

### 1. Vercel configuration (the actual root-cause fix)

```
APP_URL=https://paid2you.com
```

Added to the **Production** environment scope only — confirmed absent from Preview and Development
(`vercel env ls preview` shows no `APP_URL` row), satisfying requirement #5: a preview deployment's own
URL can never become the value production links use, and preview links are unaffected (continue on the
existing localhost default, exactly as before this fix — no new behavior introduced there).

### 2. `src/config/env.ts` — prevent silent recurrence

Added a cross-field `.superRefine`: if `APP_ENV === "production"` and `APP_URL` resolves to
`localhost`/`127.0.0.1`/`::1`, `parseServerEnv` now throws `EnvironmentValidationError` instead of
silently accepting the default. This is a narrow, single-file addition to the *existing* validation
mechanism (mirrors `AUDIT_HASH_SECRET`/`AUTH_PASSWORD_PEPPER`'s own "throw a clear error rather than
silently degrade" precedent in the same file) — no Resend/notification architecture touched, per
requirement #10. The next time this variable is ever left unset in a production deployment, every route
touching `getServerEnv()` fails loudly and immediately instead of quietly generating broken links again.

Enumeration protection (requirement #8) and token security/expiration (requirement #9) are both
untouched — `requestPasswordReset`'s logic, `passwordResetTokens` TTL, and the generic
`{"status":"ok",...}` response shape are unmodified; only the *link's origin* changes.

## Tests

6 new tests in `src/config/env.test.ts`: rejects localhost/`127.0.0.1` in production; names `APP_URL`
specifically in the error; confirms the *unconfigured default* itself now fails in production (the
exact incident, reproduced as a test); accepts a real production URL; confirms development/test/staging
are unaffected (still permit localhost). Full suite: **1040/1040 passed** (144/144 files — the one
previously-flaky, unrelated component test from PRSprint 14's own run passed cleanly this time too).
Typecheck/lint: clean. Build: succeeded.

## Deployment

Vercel CLI (`vercel redeploy <deployment> --target production`) — rebuilds from the exact already-CI-
verified source and picks up the newly-set `APP_URL`. Aliased back to `https://paid2you.com`.

## Second Controlled Email Verification

See the chat completion report for the exact result: a second `POST /api/auth/password-reset/request`
to the same Product Owner test address, followed by their confirmation that the received link now
starts with `https://paid2you.com/reset-password?token=`.

## Regression Checks

- `/api/health` → `"environment":"production"` (unaffected — this route never calls `getServerEnv()`).
- Resend send path (`getEmailSender` → `ResendEmailSender`) and webhook signature verification —
  unaffected; `APP_URL` only changes the CTA/link content, not the send/webhook mechanism.
- Supabase migration integrity — no migration in this fix; `supabase migration list --linked`/`db push
  --dry-run` re-verified unchanged.
- Login/logout — unaffected; `AuthService`'s session/token logic is untouched, only its email links.
- Admin — unaffected; no admin-surface code touched.

## Remaining PRSprint 14 Blockers

None beyond PRSprint 14's own already-documented EXTERNAL BLOCKER status — domain/API key/webhook are
now live (this session), so that blocker is itself resolved; nothing new is introduced by this fix.
