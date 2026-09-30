# Stage 4 — Final Remediation Evidence Manifest

Generated in response to: PAID2YOU — STAGE 4 FINAL SENIOR-ARCHITECT REMEDIATION AND CLOSURE ORDER (post-Codex independent review).

## Repository identity

- Root: `C:/Development/PAY2PAY-bank-v3`
- Branch: `architecture/bank-managed-payments-v3`
- Starting HEAD: `93bbbbf8950010d4c0a70c7133339dc352ebd0fd`
- Final HEAD: `93bbbbf8950010d4c0a70c7133339dc352ebd0fd` (unchanged — no commits made)
- Dirty-tree inventory: see `git-status-final.txt` in this directory (raw `git status --porcelain` output) — every pre-existing Stage 1–3 uncommitted file preserved untouched; only the files below were added/modified this round.

## Stage 4 production files (this remediation round)

| File | Change |
|---|---|
| `src/lib/ledger/balanceService.ts` | `SettlementBalanceResolution` (none/forgiveness/restoredBalance) replaces the narrower forgiveness-only reader; `classifyPaymentAttempts` now interprets `refund_correction` as undoing its paired `refund`. |
| `src/lib/ledger/drizzleSettlementBalanceReader.ts` (new; replaces deleted `drizzleSettlementForgivenessReader.ts`) | Real reader implementing the completed/forgive_permanently/restore_stated/none precedence. |
| `src/lib/ledger/getBalanceService.ts` | Wires the new reader. |
| `src/lib/ledger/testFakes.ts` | `InMemorySettlementBalanceReader` replaces `InMemorySettlementForgivenessReader`; `InMemoryReconciliationExceptionRepository.recordExceptionAtomically` added (prior round). |
| `src/lib/agreements/agreementProgressService.ts`, `src/lib/ledger/agreementCompletionService.ts` | `settlementState` type widened to include `"settled_in_full"` (prior round, unaffected by this round). |
| `src/lib/ledger/reconciliationService.ts`, `src/lib/ledger/drizzleReconciliationExceptionRepository.ts` | `recordExceptionAtomically` (`pg_advisory_xact_lock`-guarded) closes the REC-02-demonstrated race (prior round). |
| `src/lib/payouts/payoutService.ts` | `ensureConfirmationAuditRecorded`/`ensureReturnAuditRecorded` repair a missing required audit event on the `already_confirmed`/`already_returned` idempotent-replay branch, using a new optional `auditFinder` dependency — never reconfirms/re-returns financially, never duplicates the ledger effect. |
| `src/lib/payouts/getPayoutService.ts` | Wires `auditFinder: new DrizzleAdminAuditReader()`. |
| `src/lib/payouts/drizzlePayoutAttemptRepository.ts` | Injectable `db` constructor parameter (prior round). |
| `scripts/postgres-test-db.mjs` | `--stage4-only` selector, grown to the fixed file list below. |

## Stage 4 test files

| File | Purpose |
|---|---|
| `src/lib/ledger/balanceService.test.ts` | SET-FINAL-01..04, SET-02/SET-03 (supporting), REFUND-CORRECTION-BALANCE-01 (in-memory fakes). |
| `src/lib/ledger/settlementBalanceReader.postgres.test.ts` (new) | SETTLEMENT-READER-01..04 — real persisted `settlement_proposal` rows, real `DrizzleSettlementBalanceReader`, end-to-end through `BalanceService`. |
| `src/lib/ledger/refundCorrection.postgres.test.ts` | REFUND-CORRECTION-01, now also asserting `BalanceService` economic-balance correctness. |
| `src/lib/payments/correctiveEventAccounting.postgres.test.ts` | COR-01, COR-02. |
| `src/lib/ledger/reconciliationDrift.postgres.test.ts` | REC-01, REC-02. |
| `src/lib/payouts/payoutAtomicity.postgres.test.ts` | STAGE4-MIGRATION, PAY-01 (rebuilt with a genuine two-worker barrier forcing the real unique-conflict recovery branch), PAY-02, PAY-03, PAY-04, AUD-01, AUD-02 (new). |
| `src/lib/settlements/settlementBinding.postgres.test.ts` | Pre-existing; re-run as the directly-affected regression check for the `BalanceService` change. |

## Stage 4 migration

`supabase/migrations/20260928000000_ledger_entry_type_stage4_parity.sql` — exactly:
```sql
ALTER TYPE "public"."ledger_entry_type" ADD VALUE IF NOT EXISTS 'refund_correction';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE IF NOT EXISTS 'payout_returned';
```
No historical migration modified (confirmed: `git status` shows no change to any file under `supabase/migrations/` other than this one new file).

## FI-01 through FI-10 → evidence mapping

| FI | Evidence |
|---|---|
| FI-01 | SET-FINAL-01..04, SETTLEMENT-READER-01..04, REFUND-CORRECTION-BALANCE-01, REFUND-CORRECTION-01 |
| FI-02 | Existing payout/UI-distinctness evidence (unchanged) + PAY-01..04 |
| FI-03 | PAY-01 (corrected conflict-path proof), PAY-02 |
| FI-04 | REFUND-CORRECTION-01, PAY-04, COR-01 |
| FI-05 | Replay assertions across PAY-02/03/04, AUD-01/02, REFUND-CORRECTION-01, COR-02, REC-01/02 |
| FI-06 | COR-02 + existing R-B36 (representative coverage) |
| FI-07 | PAY-03 + existing payment/ledger evidence |
| FI-08 | REC-01/REC-02 + WP-02/settlement-balance closure |
| FI-09 | PAY-03 (local atomicity) + existing payment-side evidence; provider-independent boundary |
| FI-10 | AUD-01, AUD-02 (new — payout audit recovery) + existing R04 audit hash-chain evidence |

## G4-01 through G4-14 → evidence mapping

All fourteen gates map to the same evidence as their corresponding FI(s) above, plus: G4-12 (regression preservation) → `broader-regression-output.txt` (260 files / 2255 tests, 0 failures); G4-13 (real Postgres proof) → `postgres-run-output.txt` (6 files / 30 tests, 0 failures, exit 0).

## Raw evidence files in this directory (prior round — preserved unmodified)

- `postgres-run-command.txt` / `postgres-run-output.txt` — Stage 4 focused PostgreSQL campaign before S4-03, 6 files / 30 tests, exit code 0.
- `focused-unit-regression-command.txt` / `focused-unit-regression-output.txt` — directly affected ledger/agreement/settlement/payout/ach non-Postgres unit suites, exit code 0.
- `typecheck-command.txt` / `typecheck-output.txt` — exit code 0.
- `lint-command.txt` / `lint-output.txt` — exit code 0 (12 pre-existing warnings, none in Stage 4 files).
- `broader-regression-command.txt` / `broader-regression-output.txt` — `npm test`, 260 files / 2255 tests, exit code 0.
- `git-status-final.txt` — git status snapshot as of the prior round's close.

---

## ADDENDUM — S4-03 remediation (concurrent payout audit repair idempotency)

### Root cause (confirmed per Step 1 of the governing order)

`ensureConfirmationAuditRecorded`/`ensureReturnAuditRecorded` (`src/lib/payouts/payoutService.ts`) previously performed a plain query (`auditFinder.listForTarget`) then a conditional `audit.record(...)` write — two separate, unserialized operations. Two genuinely concurrent replay callers could each observe the required event as absent and each append, producing two audit events for one financial effect (the financial mutation itself was never at risk — already fully race-proof via `confirmAtomically`/`returnAtomically`'s own row lock).

### Production files changed (this round only)

| File | Change |
|---|---|
| `src/lib/audit/auditService.ts` | New optional `AuditEventRepository.ensureAtomically(...)`; new `AuditService.ensureRecorded(identity, payload, findExisting?)` — the one atomic get-or-create entry point. |
| `src/lib/audit/drizzleAuditEventRepository.ts` | `appendAuditEventTxBound` refactored to delegate to a new shared `appendAuditEventAfterLockAcquiredTxBound` helper (no behavior change); new `ensureAuditEventAtomicallyTxBound`/`ensureAuditEventAtomically` (transaction → existing `pg_advisory_xact_lock` chain lock → existence recheck by `(targetResourceType, targetResourceId, action)` → conditional append via the same tail-read/hash/insert sequence → commit); new `DrizzleAuditEventRepository.ensureAtomically` wiring. |
| `src/lib/payouts/payoutService.ts` | `ensureConfirmationAuditRecorded`/`ensureReturnAuditRecorded` now call `audit.ensureRecorded(...)` instead of a caller-composed check-then-write; `auditFinder` retained only as the non-atomic fallback's existence check (never reached in production). |

No schema change. No migration. No new business rule. No new audit store. No change to payout financial semantics.

### Atomic ensure architecture

```
db.transaction
  → SELECT pg_advisory_xact_lock(hashtext(AUDIT_CHAIN_LOCK_KEY_A), hashtext(AUDIT_CHAIN_LOCK_KEY_B))   [existing chain lock, reused verbatim]
    → SELECT ... WHERE targetResourceType = ? AND targetResourceId = ? AND action = ?                  [existence recheck, inside the lock]
      → found:  return existing event, no insert
      → absent: appendAuditEventAfterLockAcquiredTxBound(tx, payload, computeHash)                     [same tail-read/hash/insert as appendAtomically]
  → commit (or rollback on error — lock and any insert released/undone together)
```

### AUD-CONCURRENT-01 result

PASS. Payout financially confirmed directly via `DrizzleAtomicPayoutConfirmer` (audit genuinely absent, no fault injection needed). Two genuinely concurrent `confirmPayout` replay calls, each on its own isolated PostgreSQL connection (`AuditService(new DrizzleAuditEventRepository(isolatedX.db))`): both resolve `status: "confirmed"`; exactly one `payout_attempt` row; exactly one `payout` ledger entry; exactly one `payout_confirmed` audit event; hash-chain linkage verified against its immediate predecessor.

### AUD-CONCURRENT-02 result

PASS. Identical structure for `returnPayout`/`payout_returned`: exactly one `payout_returned` ledger entry; exactly one `payout_returned` audit event; hash-chain linkage verified.

### Existing AUD-01/AUD-02 result

PASS, unmodified — sequential missing-audit recovery and no-duplicate-financial-effect still hold.

### Audit-chain regression result (R04)

PASS — `auditService.postgres.test.ts`: R04-A (contention proof via `pg_stat_activity`), R04-A (20+ concurrent connections, one chain, every hash recomputes), R04-B (forced FK-violation rollback, tail continues correctly). Confirms the `appendAuditEventTxBound` refactor preserved every existing guarantee.

### Final Stage 4 PostgreSQL result (runner-reported, authoritative)

**7 files passed (7) / 35 tests passed (35) / exit 0.** (`settlementBalanceReader.postgres.test.ts`, `settlementBinding.postgres.test.ts`, `payoutAtomicity.postgres.test.ts` [incl. AUD-01/02/CONCURRENT-01/02], `correctiveEventAccounting.postgres.test.ts`, `reconciliationDrift.postgres.test.ts`, `refundCorrection.postgres.test.ts`, `auditService.postgres.test.ts` [R04, added this round as the audit regression guard].)

### Typecheck/lint result

Both exit 0. Lint: 12 pre-existing warnings, none in any file touched this round.

### Broader regression result

`npm test`: **260 files / 2255 tests / exit 0** — identical count to the prior baseline (the two new concurrency tests are PostgreSQL-only and correctly excluded; no placement was altered to change this number).

### FI re-evaluation (only the two blocked by this defect)

- **FI-05 (idempotent replay): PROVEN** — AUD-CONCURRENT-01/02 close the last unproven replay surface.
- **FI-10 (financial provenance): PROVEN** — payout audit repair is now genuinely atomic under real concurrency; R04 confirms no regression to the underlying hash-chain guarantees.

All other previously verified FI statuses unchanged (no regression found).

### G4 re-evaluation (only the three flagged)

- **G4-06 (idempotency): PASS**
- **G4-11 (financial provenance): PASS**
- **G4-14 (adversarial financial scenarios): PASS**

All other previously accepted gates remain accepted (no regression found).

### Material defects

**0.**

### Additional raw evidence files (S4-03 round)

- `postgres-run-command-s4-03.txt` / `postgres-run-output-s4-03.txt` — first post-implementation run, 6 files / 32 tests, exit 0.
- `postgres-run-command-s4-03-final.txt` / `postgres-run-output-s4-03-final.txt` — run including the R04 audit regression file, 7 files / 35 tests, exit 0.
- `s4-03-unit-regression-command.txt` / `s4-03-unit-regression-output.txt` — audit unit tests (8/8), exit 0.
- `s4-03-typecheck-command.txt` / `s4-03-typecheck-output.txt`, `s4-03-lint-command.txt` / `s4-03-lint-output.txt` — exit 0 each.
- `s4-03-broader-regression-command.txt` / `s4-03-broader-regression-output.txt` — `npm test`, 260 files / 2255 tests, exit 0.
- `git-status-final-s4-03.txt` — `git status --porcelain` snapshot as of that round's close.

---

## ADDENDUM 2 — S4-03-FINAL remediation (initial-emission vs. replay audit race)

### Root cause

Even after the S4-03 fix, `confirmPayout`/`returnPayout`'s "newly confirmed"/"newly returned" branches still called `this.deps.audit.record(...)` **unconditionally** (no identity-based existence check — `record()`'s own dedup only keys on `providerEventId`, which payout audit events never set). Under two genuinely concurrent `confirmPayout` calls for the SAME payout, the financial row lock determines a winner (`"confirmed"`) and a loser (`"already_confirmed"`), but these are TWO SEPARATE, unserialized-relative-to-each-other audit code paths: the winner's unconditional `record()` and the loser's atomic `ensureRecorded()` could each still create an event if timed just right (e.g., the replay caller's atomic check runs and inserts before the "genuinely new" caller's unconditional append ever executes). Both paths use the same advisory lock, but only one of them (`ensureRecorded`) actually checks existence — so serialization alone wasn't sufficient; both had to become the SAME operation.

### Production files changed (this round only)

`src/lib/payouts/payoutService.ts` — `confirmPayout`'s and `returnPayout`'s first-time ("confirmed"/"returned") branches now call `ensureConfirmationAuditRecorded`/`ensureReturnAuditRecorded` (the same atomic `ensureRecorded` path the replay branch already used) instead of an unconditional `this.deps.audit.record(...)`. No unconditional direct append remains for `payout_confirmed`/`payout_returned`. No schema, no migration, no new business rule.

Test infrastructure: `FlakyAuditEventRepository` (`payoutAtomicity.postgres.test.ts`) extended to also intercept `ensureAtomically` (sharing the same fail-count as `appendAtomically`), since AUD-01/AUD-02's fault injection must reach whichever entry point the (now-unified) code actually calls.

### New tests: AUD-INITIAL-RACE-01 / AUD-INITIAL-RACE-02

Both start from a genuinely **unconfirmed/unreturned** payout — unlike AUD-CONCURRENT-01/02 (which start already-confirmed/returned, exercising only the replay-vs-replay race), these two force two genuinely concurrent callers to race for the row lock itself, so one takes the "newly confirmed/returned" branch and the other the replay branch — proving the race BETWEEN those two different branches is closed, not just within the replay branch alone. Both: real two-connection concurrency, exactly one financial effect, exactly one audit event, hash-chain linkage verified. **PASS.**

### Final complete verification campaign

- **Stage 4 PostgreSQL selector** (7 files, includes settlement balance reader, settlement binding, payout atomicity [all 10 payout-audit cases: AUD-01, AUD-02, AUD-CONCURRENT-01/02, AUD-INITIAL-RACE-01/02, plus STAGE4-MIGRATION/PAY-01..04], corrective event accounting, reconciliation, refund correction, audit R04): **37 tests passed (37), 0 failed, exit 0.**
- **Focused unit/integration regression** (ledger, agreements, settlements, ach, payouts, audit — non-Postgres): **19 files / 309 tests passed, exit 0.**
- **Typecheck:** exit 0. **Lint:** exit 0 (12 pre-existing warnings, none in touched files).
- **Broader `npm test`:** **260 files / 2255 tests passed, exit 0** — identical count to every prior baseline; no Stage 4 regression.

### Additional raw evidence files (S4-03-FINAL round)

- `postgres-run-command-final.txt` / `postgres-run-output-final.txt` — **the authoritative final Stage 4 PostgreSQL result** (7 files / 37 tests, exit 0). (One earlier attempt in this round failed 2/37 due to a test-infrastructure gap — the flaky repository not yet intercepting `ensureAtomically` — fixed and superseded by this file; not a production defect.)
- `final-unit-regression-command.txt` / `final-unit-regression-output.txt` — 19 files / 309 tests, exit 0.
- `final-typecheck-command.txt` / `final-typecheck-output.txt`, `final-lint-command.txt` / `final-lint-output.txt` — exit 0 each.
- `final-broader-regression-command.txt` / `final-broader-regression-output.txt` — `npm test`, 260 files / 2255 tests, exit 0.
- `git-status-final-complete.txt` — final `git status --porcelain` snapshot, HEAD unchanged throughout (`93bbbbf8950010d4c0a70c7133339dc352ebd0fd`).
