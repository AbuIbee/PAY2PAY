# Environment Variables

Every environment variable the application reads, classified per Sprint 1's requirement:
which deployment context(s) need it, and whether it is server-only or client-safe. Source of
truth for the *names* and validation rules is `src/config/env.ts` (server-only schema) and
`src/config/public-env.ts` (client-safe schema) — this document explains *why* each one exists and
where it must be configured; it does not duplicate validation logic.

**Architecture note on "Supabase":** this project's database access goes through a standard
Postgres connection string (`DATABASE_URL`) via Drizzle ORM (`src/db/client.ts`), not the
`supabase-js` client SDK — no `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_ANON_KEY` /
`SUPABASE_SERVICE_ROLE_KEY` exist anywhere in this codebase. Supabase is used only as the *Postgres
hosting platform*: `DATABASE_URL` should point at a Supabase project's connection string (direct or
pooled), and the `early_access_leads` table's Row Level Security policies (see
`docs/sprints/SPRINT_01_PublicPreview _VercelReadiness.md` item 7 and
`drizzle/migrations/0001_early_access_leads.sql`) are written defensively for Supabase's
auto-generated PostgREST API surface, even though this app's own code never calls that API — all
database access in this codebase is server-side only, through `getDb()`. This is a deliberate
continuation of the existing architecture (no `supabase-js` was present before Sprint 1 and none
was added), not an oversight; flagged here for explicit visibility since the sprint file's wording
("approved Supabase table") could otherwise be read as requiring the client SDK.

## Variables

| Variable | Classification | Required in | Purpose |
|---|---|---|---|
| `APP_ENV` | Server-only | local dev, preview, staging, production (optional — defaults to `development`) | Distinguishes staging from production at the application-config level, since Next.js's own `NODE_ENV` only knows development/test/production. |
| `DATABASE_URL` | Server-only, **secret** (contains credentials) | local dev, preview, staging, production — required by any request that touches the database, including Sprint 1's `POST /api/early-access` | Postgres connection string. Points at a local Postgres in development and at the project's Supabase Postgres connection string in preview/staging/production. Never required for the landing page's own static rendering — only when a database-backed route (like early-access submission) actually runs, per `src/db/client.ts`'s lazy-connection pattern. |
| `AUDIT_HASH_SECRET` | Server-only, **secret** | staging, production (required wherever audit-logged code paths run); optional in preview/local dev if those routes aren't exercised | Pepper for the audit hash chain (`src/lib/audit/hash.ts`). Not used by Sprint 1's early-access feature. |
| `AUTH_PASSWORD_PEPPER` | Server-only, **secret** | staging, production (required wherever auth routes run); optional in preview/local dev if those routes aren't exercised | Pepper mixed into password hashes (`src/lib/auth/password.ts`). Not used by Sprint 1's early-access feature. |
| `NEXT_PUBLIC_APP_NAME` | Client-safe | local dev, preview, staging, production (optional — defaults to `PAY2PAY`) | Inlined into the browser bundle at build time. Contains no secret. |
| `NEXT_PUBLIC_APP_ENV` | Client-safe | local dev, preview, staging, production (optional — defaults to `development`) | Inlined into the browser bundle at build time. Contains no secret. |
| `FEATURE_<FLAG_NAME_SCREAMING_SNAKE_CASE>` | Server-only, optional | any environment, as needed | Per-environment override for a flag in `src/lib/feature-flags.ts` (e.g. `FEATURE_EXAMPLE_FOUNDATION_FLAG=false`). Never sent to the browser. |

No new environment variable was introduced by Sprint 1 — the early-access feature reuses
`DATABASE_URL`, which already existed.

## Vercel configuration checklist (Sprint 1 acceptance)

- `DATABASE_URL`, `AUDIT_HASH_SECRET`, `AUTH_PASSWORD_PEPPER` must be set as **server-only** Vercel
  environment variables (never exposed with a `NEXT_PUBLIC_` prefix).
- `NEXT_PUBLIC_APP_NAME` / `NEXT_PUBLIC_APP_ENV` may be set at any scope; they are safe to appear in
  the client bundle by design.
- No variable in this table is a "production financial credential" (payment-processor API key,
  bank credential, etc.) — none exist in this codebase yet, consistent with Sprint 1's acceptance
  criterion that no payment functionality is implemented.
- `.env.local` (gitignored) holds local-development-only placeholder values and must never be
  committed; `.env.example` documents the shape without real values.
