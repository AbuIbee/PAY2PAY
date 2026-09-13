import "server-only";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { ledgerJournalEntry, paymentAttempt, paymentRetry } from "@/db/schema";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Mirrors `PartialPaymentAutoApplicationService`'s own identical bound/rationale — see that class's own doc comment. */
const MAX_RETRY_LINEAGE_HOPS = 25;

/** A payment attempt status that may still, in the future, reach "succeeded" — mirrors `UNRESOLVED_PAYMENT_ATTEMPT_STATUSES` (installmentSettlementTx.ts) exactly: read directly from `ALLOWED_SOURCE_STATUSES_FOR_DESTINATION`'s own union, never a separately hand-maintained list. */
const IN_FLIGHT_ATTEMPT_STATUSES = new Set(["pending", "scheduled", "submitted", "processing"]);

export type PartialPaymentClearedEvidence = "cleared" | "in_flight" | "not_cleared" | "unknown";

interface AttemptRow {
  id: string;
  status: string;
}

async function findDirectAttempt(tx: Tx, idempotencyKey: string): Promise<AttemptRow | null> {
  const rows = await tx.select({ id: paymentAttempt.id, status: paymentAttempt.status }).from(paymentAttempt).where(eq(paymentAttempt.idempotencyKey, idempotencyKey)).limit(1);
  return rows[0] ?? null;
}

async function hasClearedEntry(tx: Tx, paymentAttemptId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: ledgerJournalEntry.id })
    .from(ledgerJournalEntry)
    .where(and(eq(ledgerJournalEntry.paymentAttemptId, paymentAttemptId), eq(ledgerJournalEntry.entryType, "payment_cleared")))
    .limit(1);
  return rows.length > 0;
}

type ReplacementLookup = { kind: "none" } | { kind: "pending" } | { kind: "unknown" } | { kind: "attempt"; attempt: AttemptRow };

/**
 * R11 PASS B1 — FINAL LIFECYCLE CLOSURE (Defect 1 — forward-walk legacy safety). Given an original
 * (failed) attempt id, finds whatever retry row (if any) was scheduled for it, and classifies:
 *   - `"none"` — no retry row exists at all, or it was explicitly `canceled` (intentionally called
 *     off — e.g. a different payment already resolved the installment) — no replacement will ever
 *     come from it: a proven terminal leaf.
 *   - `"pending"` — a retry row exists and is still `scheduled`/`claimed` (not yet fired) — a
 *     trusted correlated payment that STILL MAY clear later.
 *   - `"attempt"` — the retry has `fired`; its resulting attempt is returned. Looked up via the
 *     retry row's own durable `resultingPaymentAttemptId` WHEN SET, falling back to the exact,
 *     deterministic `retry-<id>` idempotencyKey lookup for a LEGACY row from before
 *     `establishDurableDispatchIntent`'s Phase-A write existed — this is what makes FORWARD
 *     lineage-walking (proposal -> attempt, used by expiration's own evidence check) robust
 *     regardless of whether that column was ever populated, mirroring
 *     `PartialPaymentAutoApplicationService.resolveLineage`'s identical BACKWARD-walk precedent.
 *   - `"unknown"` — `fired` but no resulting attempt is findable by either method: corrupt/
 *     unexpected data, fail safe.
 */
async function findReplacementAttempt(tx: Tx, originalPaymentAttemptId: string): Promise<ReplacementLookup> {
  const retryRows = await tx
    .select({ id: paymentRetry.id, status: paymentRetry.status, resultingPaymentAttemptId: paymentRetry.resultingPaymentAttemptId })
    .from(paymentRetry)
    .where(eq(paymentRetry.originalPaymentAttemptId, originalPaymentAttemptId))
    .limit(1);
  const retryRow = retryRows[0];
  if (!retryRow) return { kind: "none" };
  if (retryRow.status === "canceled") return { kind: "none" };
  if (retryRow.status === "scheduled" || retryRow.status === "claimed") return { kind: "pending" };

  // status === "fired" — a definite provider response was obtained for this retry.
  let next: AttemptRow | null = null;
  if (retryRow.resultingPaymentAttemptId) {
    const rows = await tx.select({ id: paymentAttempt.id, status: paymentAttempt.status }).from(paymentAttempt).where(eq(paymentAttempt.id, retryRow.resultingPaymentAttemptId)).limit(1);
    next = rows[0] ?? null;
  }
  if (!next) {
    const rows = await tx.select({ id: paymentAttempt.id, status: paymentAttempt.status }).from(paymentAttempt).where(eq(paymentAttempt.idempotencyKey, `retry-${retryRow.id}`)).limit(1);
    next = rows[0] ?? null;
  }
  if (!next) return { kind: "unknown" };
  return { kind: "attempt", attempt: next };
}

/**
 * R11 PASS B1 — FINAL LIFECYCLE CLOSURE (Defect 2 — EXPIRATION EVIDENCE CLASSIFICATION). The
 * forward-walking mirror of `PartialPaymentAutoApplicationService`'s own backward lineage
 * resolution — given a proposal id, classifies its OWN dispatch/retry lineage into EXACTLY one of
 * four evidence states (Defect 2A):
 *
 *   - `"cleared"` — a trusted correlated attempt has durable `payment_cleared` evidence, checked
 *     REGARDLESS of that attempt's CURRENT status (the SAME "historical clearing wins" rule
 *     `PartialPaymentAutoApplicationService.applyClearedPayment` applies — a since-reversed/
 *     refunded/disputed/returned attempt that DID durably clear is still `"cleared"` here, so
 *     expiration correctly never fires while the proposal is merely waiting for the (already
 *     unstoppable) application effect to catch up).
 *   - `"in_flight"` — a trusted correlated payment still may clear: `succeeded` with no
 *     `payment_cleared` entry yet (the succeeded-before-ledger interval), any of
 *     pending/scheduled/submitted/processing, or a retry still `scheduled`/`claimed` (not yet
 *     fired).
 *   - `"not_cleared"` — correlation is conclusively known and NOTHING in the lineage ever cleared
 *     or can still clear: no payment was ever initiated at all, or every attempt in a fully-traced
 *     chain is terminal (failed/canceled) with no further pending retry.
 *   - `"unknown"` — the bound was exhausted while a chain still continued, or a referenced ancestor
 *     (a retry's own resulting attempt) is missing/corrupt.
 *
 * Takes `tx` directly (the SAME low-level, transaction-scoped-query pattern
 * `computeInstallmentSettlementWithinTx` established) — this is NOT a general-purpose service-layer
 * dependency; it exists SPECIFICALLY so `DrizzlePartialPaymentRepository.expireIfSafe` can run this
 * check from WITHIN the SAME transaction already holding the agreement + proposal row locks, so the
 * financial-clearing evidence and the expiration transition share one correctness boundary — never
 * a separate, pre-transaction read followed by an unconditional write. `expireIfSafe` must NEVER
 * treat `"cleared"`, `"in_flight"`, or `"unknown"` as authorization to expire — ONLY
 * `"not_cleared"` may.
 */
export async function computePartialPaymentClearedEvidenceWithinTx(tx: Tx, partialPaymentRequestId: string): Promise<PartialPaymentClearedEvidence> {
  let current: AttemptRow | null = await findDirectAttempt(tx, `partial-payment-${partialPaymentRequestId}`);
  if (!current) return "not_cleared"; // never initiated at all — nothing to correlate, nothing to clear.

  for (let hop = 0; hop < MAX_RETRY_LINEAGE_HOPS; hop++) {
    if (await hasClearedEntry(tx, current.id)) return "cleared"; // historical clearing wins, regardless of current status.
    if (current.status === "succeeded" || IN_FLIGHT_ATTEMPT_STATUSES.has(current.status)) return "in_flight";

    const replacement = await findReplacementAttempt(tx, current.id);
    if (replacement.kind === "none") return "not_cleared";
    if (replacement.kind === "pending") return "in_flight";
    if (replacement.kind === "unknown") return "unknown";
    current = replacement.attempt;
  }
  // Bound reached while a chain still continued — exhaustion, never silently "not cleared".
  return "unknown";
}
