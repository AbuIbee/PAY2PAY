# PAY2PAY

Ethical, interest-free repayment agreements — U.S. web application (Next.js PWA).

**Current status: Phase 0 — technical foundation.** No agreements, identity verification,
electronic signatures, or payments are implemented yet. See `docs/IMPLEMENTATION_PLAN.md` for
the full phase breakdown and `docs/PAY2PAY_MASTER_SPEC.md` for the product specification this
project implements.

## Prerequisites

- Node.js 20.9+ (Next.js 16 minimum; this project was built and verified on Node 24)
- npm
- A PostgreSQL database — only required once you run code that actually touches it (the
  Phase 0 health check and page rendering do not require a live database)

## Setup

```bash
npm install
cp .env.example .env.local
# then edit .env.local and fill in real values (see "Environment configuration" below)
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the development server (Turbopack, hot reload) at http://localhost:3000 |
| `npm run build` | Production build (also type-checks as part of the Next.js build) |
| `npm run start` | Start the production server from a prior `npm run build` |
| `npm run lint` | Run ESLint (flat config, Next.js core-web-vitals + TypeScript + accessibility rules) |
| `npm run typecheck` | Run `tsc --noEmit` (strict mode plus extra strictness flags — see `tsconfig.json`) |
| `npm test` | Run the Vitest test suite once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run db:generate` | Generate SQL migrations from `src/db/schema/` via drizzle-kit (no live DB needed) |
| `npm run db:migrate` | Apply generated migrations to `DATABASE_URL` (requires a real, reachable database) |

## Environment configuration

Environment variables are validated at startup by `src/config/env.ts` (server-only) and
`src/config/public-env.ts` (client-safe). Required server variables throw a descriptive
`EnvironmentValidationError` if missing or malformed — see `src/config/env.test.ts` for the
exact rejection behavior.

- **Server-only variables** (never sent to the browser): `DATABASE_URL`, `AUDIT_HASH_SECRET`.
  These are validated lazily, the first time code that actually needs them runs (e.g. the
  database client factory) — not at every page load — so the app can start and serve the
  health check without a database configured.
- **Public variables** (inlined into the client bundle at build time — never put a secret
  here): anything prefixed `NEXT_PUBLIC_`.
- **`APP_ENV`** extends Next.js's own `development`/`test`/`production` distinction with a
  `staging` option, so a staging deployment can be configured distinctly from both local
  development and production at the application-config level.

See `.env.example` for the full list with explanations. Copy it to `.env.local` (gitignored)
for local development; use your deployment platform's secret manager for staging/production —
never commit real values.

## Project structure

```
src/
  app/                  Next.js App Router routes
    api/health/         Health-check endpoint (GET /api/health)
    layout.tsx           Root layout — server component; renders the responsive shell
    page.tsx              Home page (server component)
    error.tsx               Route-level error boundary (client component; Next.js requirement)
    global-error.tsx         Root-level error boundary (client component; Next.js requirement)
    manifest.ts               PWA manifest route
    globals.css                 Responsive/accessible baseline styles
  components/            Shared UI. Server components by default; anything with "use client"
                          at the top (e.g. MobileNavToggle.tsx) is a client component — that's
                          the project's server/client boundary convention.
  config/                 env.ts (server-only) and public-env.ts (client-safe) — kept as
                          separate module graphs on purpose so a secret can never accidentally
                          end up reachable from client code via a shared import.
  db/
    schema/               Drizzle ORM table definitions (source of truth for the data model)
    client.ts              Lazy, memoized Drizzle client factory (server-only)
  lib/
    logger.ts               Structured (JSON) logger
    errors.ts                 Centralized error hierarchy + safe client-facing error mapping
    api-handler.ts             Wraps API route handlers with the above two
    feature-flags.ts            Minimal typed feature-flag registry
    audit/                        Append-only, hash-chained audit trail service
drizzle.config.ts        drizzle-kit configuration (schema location, migration output)
vitest.config.ts         Test runner configuration (jsdom environment, path alias)
.github/workflows/ci.yml  CI: install, lint, build, typecheck, test on every push/PR
```

## Server vs. client components

This project follows Next.js App Router's default: every component is a **server component**
unless it starts with `"use client"`. Server components can read server-only config directly;
client components cannot import anything that pulls in `src/config/env.ts` (the `server-only`
package makes that a **build-time error**, not a runtime leak — see "Secrets and the client
bundle" below). `src/components/MobileNavToggle.tsx` is the one intentional client component in
Phase 0, demonstrating the boundary; everything else in the shell (`layout.tsx`, `page.tsx`) is
a server component.

## Secrets and the client bundle

Two independent safeguards keep server secrets out of the browser bundle:

1. Next.js only ever inlines environment variables prefixed `NEXT_PUBLIC_` into client code —
   this is a framework-level guarantee, not something this project has to implement.
2. `src/config/env.ts` additionally imports the `server-only` package. If any client component
   ever imports that module (directly or transitively), the build fails immediately with a
   clear error, rather than silently shipping a secret.

## Database

`src/db/schema/` defines exactly the tables Phase 0 needs (per `docs/IMPLEMENTATION_PLAN.md`):
`user_account`, `personal_profile`, `business_profile`, `beneficial_owner`,
`business_staff_member`, `custom_role`, and the append-only `audit_event` table. No agreement,
payment, or identity-verification-provider tables exist yet — those arrive in their own phases.

No live database is required to run, build, or test this project as it stands today — the
schema is the source of truth for `npm run db:generate`, and nothing in the current codebase
executes a query against it yet. `src/lib/audit/auditService.test.ts` exercises the audit
hash-chaining logic against an in-memory fake repository instead.

## Testing

Vitest + React Testing Library, `jsdom` environment. Run `npm test`. Coverage in Phase 0:

- Environment validation rejection behavior (`src/config/env.test.ts`)
- Audit hash-chaining determinism and tamper-detection (`src/lib/audit/hash.test.ts`)
- Audit service orchestration via an in-memory repository (`src/lib/audit/auditService.test.ts`)
- Health-check endpoint response shape (`src/app/api/health/route.test.ts`)
- Centralized error-response safety (no internal error detail leaks) (`src/lib/errors.test.ts`)
- Feature-flag default/override behavior (`src/lib/feature-flags.test.ts`)
- Accessible interactive component behavior (`src/components/MobileNavToggle.test.tsx`)
- Home page renders expected content (`src/app/page.test.tsx`)

## What's deliberately not in Phase 0

Per the master specification and `docs/IMPLEMENTATION_PLAN.md`, this phase does not include:
Stripe/Plaid/ACH/debit-card integration, fake payment-success states, identity verification
workflows, agreement creation, electronic signatures, or any authentication UI/session flow
(the `user_account` schema exists; login/signup screens are intentionally out of scope for this
phase — see the completion report for that call).
