# Environment Variables

Every environment variable the application reads, classified per Sprint 1's requirement:
which deployment context(s) need it, and whether it is server-only or client-safe. Source of
truth for the *names* and validation rules is `src/config/env.ts` (server-only schema) and
`src/config/public-env.ts` (client-safe schema) — this document explains *why* each one exists and
where it must be configured; it does not duplicate validation logic.

**Architecture note on "Supabase" (updated by PRSprint 04 — this note was accurate for Sprint 1 but
had drifted):** this project's *database* access goes through a standard Postgres connection string
(`DATABASE_URL`) via Drizzle ORM (`src/db/client.ts`), not the `supabase-js` client SDK — no
`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_ANON_KEY` exist anywhere in this codebase, and no code path
ever calls Supabase's PostgREST API. That part of Sprint 1's note is still correct. However, Sprint
6 (`docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md`) added `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` to `src/config/env.ts` for a *second, unrelated* purpose: Supabase
**Storage** (the private signed-agreement-PDF bucket, `src/lib/documents/supabaseDocumentStorage.ts`),
via the `supabase-js` SDK's storage client only — never its Postgres/PostgREST client, and never
imported into any client component (`SupabaseDocumentStorage` is a server-only class; PRSprint 02's
audit independently confirmed this). So the accurate statement is: this codebase never uses
Supabase's database client SDK, but it does use Supabase's Storage client SDK, server-side only, for
one specific bucket. The `early_access_leads` table's Row Level Security policies (see
`docs/sprints/SPRINT_01_PublicPreview _VercelReadiness.md` item 7 and
`drizzle/migrations/0001_early_access_leads.sql`) remain written defensively for Supabase's
auto-generated PostgREST API surface even though no table's data is ever read through it — this
continues to be intentional defense-in-depth, not an oversight (PRSprint 02 confirmed every table in
this schema has RLS enabled with zero permissive policies, for the same reason).

## Variables

| Variable | Classification | Required in | Purpose |
|---|---|---|---|
| `APP_ENV` | Server-only | local dev, preview, staging, production (optional — defaults to `development`) | Distinguishes staging from production at the application-config level, since Next.js's own `NODE_ENV` only knows development/test/production. |
| `DATABASE_URL` | Server-only, **secret** (contains credentials) | local dev, preview, staging, production — required by any request that touches the database, including Sprint 1's `POST /api/early-access` | Postgres connection string. Points at a local Postgres in development and at the project's Supabase Postgres connection string in preview/staging/production. Never required for the landing page's own static rendering — only when a database-backed route (like early-access submission) actually runs, per `src/db/client.ts`'s lazy-connection pattern. |
| `POSTGRES_URL` | Server-only, **secret** (contains credentials), optional | any environment, only as a fallback | Fallback for `DATABASE_URL`, consulted by `parseServerEnv` (`src/config/env.ts`) and `drizzle.config.ts` only when `DATABASE_URL` is unset — `DATABASE_URL` always wins if both are present. Exists because Vercel's native Postgres storage integration provisions `POSTGRES_URL` (not `DATABASE_URL`) automatically when attached to a project. Not needed, and should be left unset, for the Supabase-hosted setup described above. |
| `AUDIT_HASH_SECRET` | Server-only, **secret** | staging, production (required wherever audit-logged code paths run); optional in preview/local dev if those routes aren't exercised | Pepper for the audit hash chain (`src/lib/audit/hash.ts`). Not used by Sprint 1's early-access feature. |
| `AUTH_PASSWORD_PEPPER` | Server-only, **secret** | staging, production (required wherever auth routes run); optional in preview/local dev if those routes aren't exercised | Pepper mixed into password hashes (`src/lib/auth/password.ts`). Not used by Sprint 1's early-access feature. |
| `NEXT_PUBLIC_APP_NAME` | Client-safe | local dev, preview, staging, production (optional — defaults to `PAY2PAY`) | Inlined into the browser bundle at build time. Contains no secret. |
| `NEXT_PUBLIC_APP_ENV` | Client-safe | local dev, preview, staging, production (optional — defaults to `development`) | Inlined into the browser bundle at build time. Contains no secret. |
| `FEATURE_<FLAG_NAME_SCREAMING_SNAKE_CASE>` | Server-only, optional | any environment, as needed | Per-environment override for a flag in `src/lib/feature-flags.ts` (e.g. `FEATURE_EXAMPLE_FOUNDATION_FLAG=false`). Never sent to the browser. |
| `CRON_SECRET` | Server-only, **secret**, optional | staging, production — only wherever `vercel.json`'s `crons` entry is actually active (Vercel Cron Jobs are a paid-plan/deployed-environment feature; not exercised in local dev) | Sprint 13 (`docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md`): shared secret `POST /api/scheduler/retry-failed-payments` checks against the `Authorization: Bearer <CRON_SECRET>` header Vercel Cron Jobs send automatically. The route throws a clear `ConfigurationError` if invoked without this set — never silently no-ops. |
| `SUPABASE_URL` | Server-only, optional | staging, production — only wherever a document-storage operation is actually attempted (Sprint 6's signed-PDF upload/download routes) | Sprint 6: base URL of the Supabase project used *only* for its Storage API (private signed-agreement-PDF bucket), via `src/lib/documents/supabaseDocumentStorage.ts`. Not a database credential — see the architecture note above. Optional at the schema level so the app still starts, and every route unrelated to PDF storage still works, with it unset; `SupabaseDocumentStorage` throws a clear `ConfigurationError` only when actually invoked without it. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only, **secret** (bypasses RLS), optional | staging, production — same trigger as `SUPABASE_URL` above | Sprint 6: service-role key for the same Supabase Storage bucket. Never sent to the browser, never referenced by any client component (`server-only` import + PRSprint 02's independent audit both confirm this). Because a service-role key bypasses RLS entirely, it must never be reused for anything beyond this one Storage client. |
| `PAYMENT_SANDBOX_WEBHOOK_SECRET` | Server-only, **secret**, optional | staging, production — only wherever a payment operation is actually attempted | Sprint 9: HMAC secret verifying inbound sandbox payment-provider webhook signatures (`src/lib/payments/getPaymentProvider.ts`). This codebase has no live payment provider (see PRSprint 04's provider-status finding below) — this secret only ever protects the sandbox webhook endpoint, never a real money-movement path. `ConfigurationError` if invoked without it. |
| `KYC_SANDBOX_WEBHOOK_SECRET` | Server-only, **secret**, optional | staging, production — only wherever a KYC/KYB operation is actually attempted | Sprint 9: HMAC secret verifying inbound sandbox KYC/KYB provider webhook signatures (`src/lib/kyc/getKycProvider.ts`). Same sandbox-only scope as `PAYMENT_SANDBOX_WEBHOOK_SECRET` above. `ConfigurationError` if invoked without it. |

No new environment variable was introduced by Sprint 1 — the early-access feature reuses
`DATABASE_URL`, which already existed. `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`PAYMENT_SANDBOX_WEBHOOK_SECRET`, and `KYC_SANDBOX_WEBHOOK_SECRET` were added by later sprints (6 and
9 respectively) but were never added to this table until PRSprint 04.

## Provider mode (PRSprint 04)

As of this PRSprint, **no live/production provider adapter exists anywhere in this codebase** for
payments, KYC/KYB, email, or SMS — `getPaymentProvider()` and `getKycProvider()` are unconditionally
wired to their sandbox implementations (no `APP_ENV`-driven branch exists because there is nothing
to branch to yet), and `src/lib/notify/*Sender.ts` is console-log-only. This means there is currently
no environment variable, in any deployment context, that could cause this codebase to move real
money, verify real identity documents, or send a real email/SMS — that capability does not exist
yet regardless of configuration (live provider architecture is PRSprint 21+'s scope, per
`docs/prsprints/PRSPRINT_PROGRAM.md`'s execution order). An authenticated Platform Admin/Owner can
see this same status, live, at `/admin` (the "Environment & provider status" panel added by this
PRSprint) — it reports configuration presence and mode labels only, never a secret value.

## Vercel configuration checklist (Sprint 1 acceptance)

- `DATABASE_URL`, `AUDIT_HASH_SECRET`, `AUTH_PASSWORD_PEPPER` must be set as **server-only** Vercel
  environment variables (never exposed with a `NEXT_PUBLIC_` prefix). If the project instead uses
  Vercel's native Postgres storage integration, the auto-provisioned `POSTGRES_URL` is also
  server-only and satisfies this requirement in place of a hand-set `DATABASE_URL` — see the
  `POSTGRES_URL` row above.
- `NEXT_PUBLIC_APP_NAME` / `NEXT_PUBLIC_APP_ENV` may be set at any scope; they are safe to appear in
  the client bundle by design.
- No variable in this table is a "production financial credential" (payment-processor API key,
  bank credential, etc.) — none exist in this codebase yet, consistent with Sprint 1's acceptance
  criterion that no payment functionality is implemented.
- `.env.local` (gitignored) holds local-development-only placeholder values and must never be
  committed; `.env.example` documents the shape without real values.
