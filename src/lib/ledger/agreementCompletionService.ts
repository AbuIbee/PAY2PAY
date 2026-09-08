import "server-only";
import { and, eq } from "drizzle-orm";
import { getServerEnv } from "@/config/env";
import { getDb, type Database } from "@/db/client";
import { agreement, agreementVersion, auditEvent, installmentScheduleItem, ledgerJournalEntry, ledgerPosting } from "@/db/schema";
import type { AuditService } from "@/lib/audit/auditService";
import { appendAuditEventTxBound } from "@/lib/audit/drizzleAuditEventRepository";
import { computeAuditEventHash, type AuditEventPayload } from "@/lib/audit/hash";
import type { AgreementTerms } from "@/lib/agreements/agreementService";
import { isPastDate } from "@/lib/agreements/schedule";
import { ValidationError } from "@/lib/errors";
import { reconstructPaidAndReversed } from "./balanceService";
import type { LedgerJournalEntryRecord } from "./ledgerService";

/**
 * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md): narrow
 * view onto `BalanceService` — this module only ever needs settlement state and the paid total.
 * Mirrors this codebase's interface-segregation precedent (e.g. `AgreementTermsReader`). Used only
 * by `checkAndAdvance` — `recomputeAfterSupersession` computes its own evidence tx-bound instead
 * (see that method's own doc comment for why).
 */
export interface AgreementBalanceComputer {
  getAgreementBalance(
    agreementId: string,
  ): Promise<{ settlementState: "unpaid" | "partially_paid" | "paid_in_full" | "overpaid"; amountPaidMinorUnits: number }>;
}

/**
 * PRSprint 18: narrow view onto `AgreementRepository` — this module only ever reads current status
 * and writes exactly the two statuses it's responsible for. Structurally compatible with the real
 * `AgreementRepository` (a function accepting the full `AgreementStatus` union may always be called
 * with the narrower "active" | "paid_in_full", and `AgreementRecord` already has a `status` field).
 * Used only by `checkAndAdvance` — `recomputeAfterSupersession` writes tx-bound, directly, instead
 * (see that method's own doc comment for why).
 */
export interface AgreementStatusRepository {
  findById(agreementId: string): Promise<{ status: string } | null>;
  /**
   * R09 corrective pass (Codex blocker 6 — agreement completion concurrency): the atomic,
   * DB-enforced counterpart to a plain read-then-write status change, mirroring
   * `AgreementRepository.updateStatusIfCurrentlyIn`'s identical contract (real `DrizzleAgreementRepository`
   * and the shared `InMemoryAgreementRepository` test fake both already implement it). Returns `false`
   * (the write never happened) the instant the row's current status is not one of `expectedStatuses` —
   * closing the gap where two concurrent `checkAndAdvance` calls could each decide from the SAME
   * stale read and one clobber the other's newer lifecycle write.
   */
  updateStatusIfCurrentlyIn(
    agreementId: string,
    expectedStatuses: readonly ("first_payment_pending" | "active" | "past_due" | "paid_in_full")[],
    newStatus: "active" | "past_due" | "paid_in_full",
  ): Promise<boolean>;
}

/**
 * PAID2YOU — PACKAGE B (Codex final review — eliminate stale agreement-recompute race): the same
 * kind of production-safe, no-op-by-default test-only affordance as `InstallmentLockTestHooks`
 * (`failedPaymentRetryCoordinator.ts`) — lets a `*.postgres.test.ts` suite pause
 * `recomputeAfterSupersession` the instant it genuinely holds the agreement row lock but BEFORE it
 * computes fresh balance/schedule evidence, long enough to deterministically prove a concurrent
 * payment settling in that exact window is still correctly observed once resumed (never raced past),
 * without any sleep-based timing assumption. Defaults to `undefined`; every production call site
 * (`new AgreementCompletionService({...})`, no `hooks` key) never sets it, so this can never run, or
 * even be checked, outside a test.
 */
export interface AgreementCompletionTestHooks {
  afterAgreementLockBeforeBalanceRead?: () => Promise<void>;
  /**
   * Awaited immediately after `recomputeAfterSupersession` has decided to demote and issued the
   * `tx.update(agreement)...` status write — genuinely inside the same open transaction — but BEFORE
   * the required audit marker is appended. If this hook throws, the whole transaction (status update
   * included) rolls back, proving the two can never durably diverge — see `recomputeAfterSupersession`'s
   * own doc comment (fix #1) for exactly why the write and its audit are atomic by construction, and
   * why the correct crash-recovery proof is "roll back together, then a clean retry fully succeeds",
   * never "the write survives while the audit is separately repaired."
   */
  beforeAuditAppend?: () => Promise<void>;
}

/**
 * PRSprint 18: closes the gap identified in docs/prsprints/PHASE_5_PREFLIGHT_FINDINGS.md §6-7 —
 * before this PRSprint, nothing in this codebase ever wrote `agreement.status = "paid_in_full"`; the
 * only existing agreement-completion write path was `SettlementService`'s `"settled_in_full"`, a
 * deliberately separate lifecycle for a negotiated settlement. This class implements the other two
 * `docs/STATE_MACHINES.md` §1 edges real ordinary installment payments require to ever reach
 * completion: "FirstPaymentPending --> Active: first payment cleared" (a prerequisite — without it, an
 * agreement whose principal spans more than one payment could never leave FirstPaymentPending for
 * Active to complete "Active --> PaidInFull" from) and "{Active,PastDue} --> PaidInFull: full balance
 * clears". Does not implement the fuller Active <-> PastDue <-> Disputed <-> PausedByAmendment web —
 * see the PRSprint 18 completion report's "known limitations" section for why that's out of this
 * PRSprint's four acceptance criteria.
 *
 * Idempotent by construction: `checkAndAdvance` only ever acts while the agreement is in one of the
 * three source statuses this class is scoped to (`first_payment_pending`/`active`/`past_due`) — once
 * it writes `paid_in_full`, a second call is a no-op via the same early-return, with no separate
 * "already done" check needed. Never touches a disputed, paused, settled, or otherwise-closed
 * agreement — a completion or activation transition must never fire underneath an open dispute or an
 * amendment-applied pause, and settlement's own `"settled_in_full"` lifecycle is untouched.
 */
export class AgreementCompletionService {
  private readonly db: Database;

  constructor(
    private readonly deps: {
      agreements: AgreementStatusRepository;
      balances: AgreementBalanceComputer;
      audit: AuditService;
      /** PAID2YOU — PACKAGE B (Codex final review): injectable for `*.postgres.test.ts` isolated-connection suites; every production call site omits it, defaulting to the shared `getDb()` singleton. Used only by `recomputeAfterSupersession`. */
      db?: Database;
      /** See `AgreementCompletionTestHooks`'s own doc comment. */
      hooks?: AgreementCompletionTestHooks;
    },
  ) {
    this.db = deps.db ?? getDb();
  }

  async checkAndAdvance(agreementId: string): Promise<void> {
    const agreement = await this.deps.agreements.findById(agreementId);
    if (!agreement) return;
    const currentStatus = agreement.status;
    if (currentStatus !== "first_payment_pending" && currentStatus !== "active" && currentStatus !== "past_due") {
      return;
    }

    let balance: { settlementState: "unpaid" | "partially_paid" | "paid_in_full" | "overpaid"; amountPaidMinorUnits: number };
    try {
      balance = await this.deps.balances.getAgreementBalance(agreementId);
    } catch (error) {
      // R09 corrective pass (Codex blocker 6): ONLY the documented "no signed terms yet" condition is
      // legitimately a no-op — every other error (a DB outage, a transient repository failure) must
      // propagate, never be swallowed, when lifecycle advancement is a REQUIRED financial consequence
      // (see PaymentWebhookService's own doc comment on required-effect classification). Swallowing an
      // unexpected error here previously let the webhook be marked "processed" while the lifecycle
      // consequence silently never happened.
      if (error instanceof ValidationError) return;
      throw error;
    }

    // "overpaid" should never actually occur — PaymentService.assertNotOverpaying blocks it upstream
    // — but a full balance clears the debt either way, so this branch is defense-in-depth, not the
    // primary enforcement point (see PHASE_5_PREFLIGHT_FINDINGS.md §7 item 2 for the actual policy).
    if (balance.settlementState === "paid_in_full" || balance.settlementState === "overpaid") {
      // R09 corrective pass (Codex blocker 6): atomic, conditional on the EXACT status this decision
      // was made from — a concurrent decision that already moved the row (e.g. another call already
      // advanced it, or it moved to a status outside this method's own scope) leaves this a no-op
      // rather than an unconditional overwrite of newer state.
      const advanced = await this.deps.agreements.updateStatusIfCurrentlyIn(agreementId, [currentStatus], "paid_in_full");
      if (advanced) await this.recordAudit(agreementId, "agreement_paid_in_full", balance.amountPaidMinorUnits);
      return;
    }

    if (currentStatus === "first_payment_pending" && balance.amountPaidMinorUnits > 0) {
      const advanced = await this.deps.agreements.updateStatusIfCurrentlyIn(agreementId, ["first_payment_pending"], "active");
      if (advanced) await this.recordAudit(agreementId, "agreement_activated", balance.amountPaidMinorUnits);
    }
  }

  /**
   * PAID2YOU — PACKAGE B (Stage 6 blocking substage — ARCHITECT DECISION; Codex final review —
   * atomic lifecycle mutation + audit, and fresh-evidence recompute): the approved backward
   * counterpart to `checkAndAdvance` — called only when a `payment.disputed`/`refunded`/`returned`/
   * `reversed` event's own transition just superseded a "succeeded" payment (see
   * `PaymentWebhookService.checkSupersessionCompletionRequired`'s own doc comment). Never infers the
   * target from the superseding event TYPE — always recomputes from live ledger/schedule truth,
   * exactly like `checkAndAdvance` does for the forward direction — but, unlike `checkAndAdvance`,
   * does so entirely inside ONE transaction, for two correctness reasons Codex's independent review
   * identified:
   *
   *   1. ATOMICITY (crash/failure between the status write and its required audit): the ORIGINAL
   *      version read the agreement, computed balance, then — as two SEPARATE steps — conditionally
   *      wrote the new status and (only if that write "just happened") recorded the audit. A crash or
   *      audit-insertion failure between those two steps left a PERMANENTLY missing audit: a retry
   *      would find `agreement.status` already at the target and, via the old "target === currentStatus
   *      -> no-op" shortcut, return without ever attempting the audit again. Fixed by doing the status
   *      UPDATE and the audit INSERT in the SAME transaction (`tx.update(agreement)...` directly,
   *      never through the injected `AgreementStatusRepository` abstraction for this write — the same
   *      reason `coordinateSupersession` writes its own installment mutation directly rather than
   *      through an abstraction it can't safely call mid-transaction) — either both commit or neither
   *      does. A durable marker check (`agreement_reopened_by_supersession` for THIS `providerEventId`)
   *      still gates re-entry, so a retry that finds the marker already present — because THIS event's
   *      effect is already fully, atomically complete — never re-evaluates or re-writes.
   *   2. STALE EVIDENCE (a concurrent payment settling between the balance read and the write): the
   *      ORIGINAL version read balance via the injected `AgreementBalanceComputer` — a separate,
   *      unlocked call, arbitrarily long before the eventual conditional write — so a payment that
   *      fully settled the agreement DURING that gap could be invisible to the decision, demoting an
   *      agreement that is, by the time of the write, already fully paid again. Fixed by locking the
   *      agreement row FIRST (`SELECT ... FOR UPDATE`) and computing balance/installment evidence
   *      FRESH, tx-bound, ONLY AFTER that lock is held (`computeFreshEvidenceWithinTx`, below) — under
   *      Postgres's per-statement READ COMMITTED snapshot, any concurrent payment's ledger effect that
   *      has ALREADY COMMITTED by the time this query runs is visible here, so a decision can never be
   *      based on balance evidence a concurrently-settling payment has already superseded. Cannot call
   *      through the injected `AgreementBalanceComputer`/`AgreementInstallmentStatusReader` here — both
   *      would open their OWN separate connection/queries against the shared, `max: 1`-pooled `getDb()`
   *      singleton, deadlocking from inside this method's own already-open transaction on it (the same
   *      class of problem `computeRemainingBalanceMinorUnitsWithinTx`, in `failedPaymentRetryCoordinator.ts`,
   *      already documents and avoids the same way — reusing `reconstructPaidAndReversed`, the exact
   *      same pure arithmetic, never a second, independently-drifting copy of the policy).
   *
   * Behavior otherwise unchanged from the original design:
   *   - Only acts while the agreement is currently "paid_in_full" or "active" — "past_due" is left
   *     alone (it already correctly represents "an overdue obligation exists"; this substage does not
   *     add a past_due -> active promotion), and "first_payment_pending"/every other status is
   *     untouched (approved: do not create a new active -> first_payment_pending backward edge here).
   *   - If evidence still shows `"paid_in_full"`/`"overpaid"` (the supersession didn't actually change
   *     the settled outcome — e.g. an overpayment absorbing the reversal, or a concurrent payment
   *     re-settling it, per fix #2 above), no write: `paid_in_full` is correct and stays, and no audit
   *     is recorded — a genuinely no-op recomputation is never reported as a demotion.
   *   - Otherwise decides `"past_due"` (any non-paid, non-waived installment's own due date has
   *     already passed) or `"active"` (otherwise). A no-op if the recomputed target equals the current
   *     status (nothing to write, and per fix #1, nothing was owed either — this exact event's own
   *     evaluation simply concluded "no change needed" this time, safely re-derivable on any future
   *     attempt since no side effect was ever produced to protect).
   */
  async recomputeAfterSupersession(agreementId: string, providerEventId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const agreementRows = await tx.select({ status: agreement.status }).from(agreement).where(eq(agreement.id, agreementId)).for("update").limit(1);
      const currentStatus = agreementRows[0]?.status;
      if (!currentStatus) return;

      // Durable disposition marker — has THIS superseding event's own agreement-recompute effect
      // already reached its one, final, durable conclusion (a real demotion, atomically committed
      // together with its own audit — see this method's own doc comment)? A "still settled, nothing
      // to do" conclusion is never durably marked; it costs nothing to safely re-derive fresh on
      // every attempt, since (unlike the demotion path) it never produces a side effect to protect.
      const existingDemotion = await tx
        .select({ id: auditEvent.id })
        .from(auditEvent)
        .where(and(eq(auditEvent.providerEventId, providerEventId), eq(auditEvent.action, "agreement_reopened_by_supersession")))
        .limit(1);
      if (existingDemotion[0]) return;

      if (currentStatus !== "paid_in_full" && currentStatus !== "active") return;

      if (this.deps.hooks?.afterAgreementLockBeforeBalanceRead) await this.deps.hooks.afterAgreementLockBeforeBalanceRead();

      const evidence = await this.computeFreshEvidenceWithinTx(tx, agreementId);
      if (!evidence) return; // no signed terms yet — mirrors checkAndAdvance's own ValidationError early-return.
      if (evidence.settlementState === "paid_in_full" || evidence.settlementState === "overpaid") return;

      const hasOverdueOutstanding = evidence.installments.some(
        (item) => item.status !== "paid" && item.status !== "waived" && isPastDate(item.dueDate),
      );
      const targetStatus: "active" | "past_due" = hasOverdueOutstanding ? "past_due" : "active";
      if (targetStatus === currentStatus) return;

      await tx.update(agreement).set({ status: targetStatus }).where(eq(agreement.id, agreementId));

      if (this.deps.hooks?.beforeAuditAppend) await this.deps.hooks.beforeAuditAppend();

      const secret = getServerEnv().AUDIT_HASH_SECRET;
      const payload: AuditEventPayload = {
        actorUserId: null,
        actorRole: "ledger_system",
        profileKind: null,
        profileId: null,
        agreementId,
        action: "agreement_reopened_by_supersession",
        occurredAt: new Date().toISOString(),
        ipAddress: null,
        deviceInfo: null,
        previousValue: null,
        newValue: { amountPaidMinorUnits: evidence.amountPaidMinorUnits },
        reason: null,
        authStrength: null,
        relatedDocumentId: null,
        relatedCaseId: null,
        targetResourceType: "agreement",
        targetResourceId: agreementId,
        providerEventId,
      };
      await appendAuditEventTxBound(tx, payload, (previousEventHash) => computeAuditEventHash(payload, previousEventHash, secret));
    });
  }

  /**
   * See `recomputeAfterSupersession`'s own doc comment (fix #2) for why this exists as a tx-bound
   * reimplementation rather than a call through `AgreementBalanceComputer`/`AgreementInstallmentStatusReader`.
   * Mirrors `BalanceService.getAgreementBalance`'s own classification exactly (never a second,
   * independently-drifting copy of the settlement-state policy) and
   * `DrizzleAgreementInstallmentStatusReader.listForAgreement`'s own shape for the schedule.
   */
  private async computeFreshEvidenceWithinTx(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    agreementId: string,
  ): Promise<{
    settlementState: "unpaid" | "partially_paid" | "paid_in_full" | "overpaid";
    amountPaidMinorUnits: number;
    installments: { status: string; dueDate: string }[];
  } | null> {
    const agreementRows = await tx.select({ currentVersionId: agreement.currentVersionId }).from(agreement).where(eq(agreement.id, agreementId)).limit(1);
    const currentVersionId = agreementRows[0]?.currentVersionId;
    if (!currentVersionId) return null;

    const versionRows = await tx.select({ terms: agreementVersion.terms }).from(agreementVersion).where(eq(agreementVersion.id, currentVersionId)).limit(1);
    const versionRow = versionRows[0];
    if (!versionRow) return null;
    const principalMinorUnits = (versionRow.terms as AgreementTerms).currentPrincipalMinorUnits;

    const entryRows = await tx.select().from(ledgerJournalEntry).where(eq(ledgerJournalEntry.agreementId, agreementId));
    const entries: LedgerJournalEntryRecord[] = [];
    for (const entryRow of entryRows) {
      const postingRows = await tx.select().from(ledgerPosting).where(eq(ledgerPosting.journalEntryId, entryRow.id));
      entries.push({
        id: entryRow.id,
        entryType: entryRow.entryType,
        agreementId: entryRow.agreementId,
        paymentAttemptId: entryRow.paymentAttemptId,
        currency: entryRow.currency,
        reason: entryRow.reason,
        createdAt: entryRow.createdAt,
        postings: postingRows.map((p) => ({ id: p.id, accountId: p.accountId, accountType: p.accountType, direction: p.direction, amountMinorUnits: p.amountMinorUnits })),
      });
    }
    const { amountPaidMinorUnits } = reconstructPaidAndReversed(entries);

    let settlementState: "unpaid" | "partially_paid" | "paid_in_full" | "overpaid";
    if (amountPaidMinorUnits <= 0) settlementState = "unpaid";
    else if (amountPaidMinorUnits < principalMinorUnits) settlementState = "partially_paid";
    else if (amountPaidMinorUnits === principalMinorUnits) settlementState = "paid_in_full";
    else settlementState = "overpaid";

    const installments = await tx
      .select({ status: installmentScheduleItem.status, dueDate: installmentScheduleItem.dueDate })
      .from(installmentScheduleItem)
      .where(eq(installmentScheduleItem.agreementVersionId, currentVersionId));

    return { settlementState, amountPaidMinorUnits, installments };
  }

  private async recordAudit(agreementId: string, action: string, amountPaidMinorUnits: number): Promise<void> {
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "ledger_system",
      profileKind: null,
      profileId: null,
      agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { amountPaidMinorUnits },
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "agreement",
      targetResourceId: agreementId,
    });
  }
}
