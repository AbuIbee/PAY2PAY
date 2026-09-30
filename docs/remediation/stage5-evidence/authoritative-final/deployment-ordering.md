# Stage 5 — G5-10 authoritative evidence: deployment ordering

Derived solely from current repository source (locked unchanged by `source-freeze.json` /
`source-freeze-drift.json` — both `supabase/migrations/20260929000000_payment_attempt_status_stage5_parity.sql`
and `src/db/schema/enums.ts` are members of `curatedStage5Files`/the full changed-file hash set,
confirmed at `driftCount: 0`) and the authoritative campaign's own migration-runner-proof result.
This artifact cites no prior closure report as evidence.

## Stage 5 migration

`supabase/migrations/20260929000000_payment_attempt_status_stage5_parity.sql`:

```sql
ALTER TYPE "public"."payment_attempt_status" ADD VALUE IF NOT EXISTS 'refund_reversed';--> statement-breakpoint
ALTER TYPE "public"."payment_attempt_status" ADD VALUE IF NOT EXISTS 'refund_failed';
```

## Migration type

**ADDITIVE ENUM PARITY MIGRATION** — two `ALTER TYPE ... ADD VALUE IF NOT EXISTS` statements.
Zero `DROP`, zero `RENAME`, zero data-mutating (`UPDATE`/`DELETE`) statements. No existing enum
value is removed or renamed.

## Exact additions

- `refund_reversed`
- `refund_failed`

## Application already recognizes these values (current source)

- `src/db/schema/enums.ts` (`paymentAttemptStatusEnum`, lines 267 and 277): both values are
  already declared in the accepted application schema, each with an explanatory doc comment
  describing it as reachable only from `"refunded"`, with no legal outgoing transition.
- `src/lib/payments/paymentService.ts` (lines 34, 42, 69, 76): both values appear in the
  service's own status-union type and its `refund_reversed: ["refunded"]` /
  `refund_failed: ["refunded"]` legal-predecessor transition tables.
- `src/lib/payments/paymentWebhookService.ts`: also references both values (confirmed present in
  current source via repository search; this file is part of the full changed-file hash set
  locked by `source-freeze.json`).

This confirms the **application code that can emit these two enum values already exists in the
current, frozen source** — the gap this migration closes is purely on the database side: an
application instance running this code today, against a database that has not yet applied this
migration, would attempt to persist a `payment_attempt_status` value the database does not yet
accept.

## Required deployment order

1. **DATABASE MIGRATION FIRST** — apply
   `supabase/migrations/20260929000000_payment_attempt_status_stage5_parity.sql`.
2. **THEN: the application version that may emit or persist those enum values** — any deploy of
   `src/lib/payments/paymentService.ts` / `paymentWebhookService.ts` in a state where
   `LedgerService.correctRefund` can produce `refund_reversed` or `refund_failed`.

## Reason

The application schema (`src/db/schema/enums.ts`) already recognizes both values — they are
compiled into the current application code's own type unions and transition tables. PostgreSQL,
however, must accept an enum value via `ALTER TYPE ... ADD VALUE` before any session can insert
or update a column to that value; attempting to persist an enum label the database does not yet
have raises a database-level rejection (`invalid input value for enum payment_attempt_status`)
that no amount of correct application logic can avoid. Applying the migration first, and only
then deploying/enabling the application code path that can emit these values, eliminates that
window entirely — the reverse order (application first) would create a live window in which a
correctly-written code path fails at the database layer for every attempted transition to either
new value.

## Authoritative campaign confirmation that this migration applies safely, in isolation, before any dependent application behavior

`authoritative-final/04-migration-runner-proof.stdout.txt`, Phase 2 (pending-only application):
this exact migration was applied as the sole pending migration against a database that already
had the preceding 57 migrations (and therefore the pre-existing, pre-Stage-5 application-
compatible schema) applied — `PHASE 2 (pending-only application): PASS — 57 pre-applied
migrations untouched, 1 pending migration applied exactly once, further rerun applied zero.` This
is the authoritative campaign's own proof that the migration is safe to apply on its own, ahead
of any application deploy, with zero effect on the 57 pre-existing migrations' state.

`authoritative-final/01-schema-parity-and-index-extraction.stdout.txt` additionally confirms,
against the fully-migrated database, that `payment_attempt_status` now contains both
`refund_reversed` and `refund_failed` (enum bidirectional comparison, 0 missing) — i.e., after
this migration is applied, the database state the application code above depends on is proven
present.

## Contract/destructive work

NONE. No table dropped, no column dropped, no existing enum value removed or renamed, no
irreversible data transformation.

## Production execution

NOT PERFORMED. Every proof above ran against disposable, throwaway PostgreSQL containers only
(`authoritative-final/04-migration-runner-proof.status.json`,
`authoritative-final/01-schema-parity-and-index-extraction.status.json`) — never production,
staging, or any shared database.

## Stage 6 dependency

NONE. This deployment-ordering determination is fully self-contained within Stage 5's own scope
(one additive enum migration and the application code that already exists to consume it) and
does not depend on, reference, or require any Stage 6 functionality.
