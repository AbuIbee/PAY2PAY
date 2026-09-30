# Stage 5 — G5-10 authoritative evidence: deployment ordering (V2)

Derived solely from current repository source (locked unchanged by `source-freeze.json` /
`source-freeze-after.json` / `source-freeze-drift.json` in this same directory —
`supabase/migrations/20260929000000_payment_attempt_status_stage5_parity.sql` is a member of
`curatedStage5Files`, confirmed at `totalSourceDrift: 0`; `src/db/schema/enums.ts` and
`src/lib/payments/paymentService.ts` are members of the full NUL-delimited changed-path set,
confirmed unchanged in `contentHashDrift: []`) and this campaign's own migration-runner-proof
result. This artifact cites no prior closure report as evidence.

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
  current source via repository search).

This confirms the **application code that can emit these two enum values already exists in the
current, frozen source** — the gap this migration closes is purely on the database side.

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
window entirely.

## Authoritative campaign (V2) confirmation that this migration applies safely, in isolation, before any dependent application behavior

`authoritative-final-v2/04-migration-runner-proof.stdout.txt`, Phase 2 (pending-only
application): this exact migration was applied as the sole pending migration against a database
that already had the preceding 57 migrations applied — `PHASE 2 (pending-only application): PASS
— 57 pre-applied migrations untouched, 1 pending migration applied exactly once, further rerun
applied zero.`

`authoritative-final-v2/01-schema-parity-and-index-extraction.stdout.txt` additionally confirms,
against the fully-migrated database, that `payment_attempt_status` now contains both
`refund_reversed` and `refund_failed` (enum bidirectional comparison, 0 missing).

## Contract/destructive work

NONE. No table dropped, no column dropped, no existing enum value removed or renamed, no
irreversible data transformation.

## Production execution

NOT PERFORMED. Every proof above ran against disposable, throwaway PostgreSQL containers only
(`authoritative-final-v2/04-migration-runner-proof.status.json`,
`authoritative-final-v2/01-schema-parity-and-index-extraction.status.json`) — never production,
staging, or any shared database.

## Stage 6 dependency

NONE. This deployment-ordering determination is fully self-contained within Stage 5's own scope
and does not depend on, reference, or require any Stage 6 functionality.
