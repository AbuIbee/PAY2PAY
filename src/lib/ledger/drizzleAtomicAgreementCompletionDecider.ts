import "server-only";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { agreement } from "@/db/schema";
import { getServerEnv } from "@/config/env";
import { appendAuditEventTxBound } from "@/lib/audit/drizzleAuditEventRepository";
import { computeAuditEventHash, type AuditEventPayload } from "@/lib/audit/hash";
import { computeAgreementCompletionEvidenceWithinTx } from "./agreementCompletionEvidenceTx";
import type { AtomicAgreementCompletionDecider } from "./agreementCompletionService";

/**
 * R11 CORRECTION PASS A (Defect A4): the same kind of production-safe, no-op-by-default test-only
 * affordance as `AgreementCompletionTestHooks` (`agreementCompletionService.ts`) — lets a
 * `*.postgres.test.ts` suite deterministically pause this transaction the instant it genuinely holds
 * the `agreement` row lock but BEFORE it reads fresh balance/installment evidence, long enough to
 * prove a concurrent reversal/supersession that commits in that exact window is still correctly
 * observed once resumed (never raced past). Defaults to `undefined`; every production call site
 * (`new DrizzleAtomicAgreementCompletionDecider()`, no argument) never sets it.
 */
export interface AtomicAgreementCompletionDeciderTestHooks {
  afterAgreementLockBeforeEvidenceRead?: () => Promise<void>;
}

/**
 * R11 CORRECTION PASS A (Defect A4 — paid_in_full STALE-EVIDENCE RACE): real implementation of
 * `AtomicAgreementCompletionDecider` — see that interface's own doc comment in
 * agreementCompletionService.ts. Deliberately structured exactly like
 * `AgreementCompletionService.recomputeAfterSupersession` (lock `agreement` FIRST, compute evidence
 * tx-bound only after the lock is held, write status + audit in the SAME transaction, directly against
 * raw Drizzle table objects rather than through an injected repository abstraction that would open its
 * OWN connection against the shared, `max: 1`-pooled `getDb()` singleton and deadlock from inside this
 * already-open transaction) — the forward (promotion) counterpart to that method's own backward
 * (demotion) fix, reusing the SAME shared evidence computation
 * (`computeAgreementCompletionEvidenceWithinTx`), never a second, independently-drifting copy of the
 * settlement-state/installment-satisfaction policy.
 *
 * R11 CORRECTION PASS A (Defect A3 — LOCK ORDERING): this transaction locks ONLY `agreement` — it
 * never locks `installment_schedule_item` (the installment evidence below is read via plain,
 * unlocked `SELECT`s inside `computeAgreementCompletionEvidenceWithinTx`, which never conflicts with
 * or waits on another transaction's installment row lock — see that function's own doc comment) — so
 * this class introduces no new lock-ordering risk against the `agreement -> installment ->
 * payment_attempt/ledger writes` order the other three fixed transactions now share.
 */
export class DrizzleAtomicAgreementCompletionDecider implements AtomicAgreementCompletionDecider {
  constructor(
    private readonly db: Database = getDb(),
    private readonly hooks?: AtomicAgreementCompletionDeciderTestHooks,
  ) {}

  async decideAndApply(agreementId: string): Promise<{ status: "active" | "paid_in_full"; amountPaidMinorUnits: number } | null> {
    return this.db.transaction(async (tx) => {
      const agreementRows = await tx.select({ status: agreement.status }).from(agreement).where(eq(agreement.id, agreementId)).for("update").limit(1);
      const currentStatus = agreementRows[0]?.status;
      if (!currentStatus) return null;
      if (currentStatus !== "first_payment_pending" && currentStatus !== "active" && currentStatus !== "past_due") return null;

      if (this.hooks?.afterAgreementLockBeforeEvidenceRead) await this.hooks.afterAgreementLockBeforeEvidenceRead();

      const evidence = await computeAgreementCompletionEvidenceWithinTx(tx, agreementId);
      if (!evidence) return null; // no signed terms yet — mirrors checkAndAdvance's own ValidationError early-return.

      if (
        (evidence.settlementState === "paid_in_full" || evidence.settlementState === "overpaid") &&
        evidence.allNonWaivedInstallmentsSatisfied
      ) {
        await tx.update(agreement).set({ status: "paid_in_full" }).where(eq(agreement.id, agreementId));
        await this.recordAuditTxBound(tx, agreementId, "agreement_paid_in_full", evidence.amountPaidMinorUnits);
        return { status: "paid_in_full", amountPaidMinorUnits: evidence.amountPaidMinorUnits };
      }

      if (currentStatus === "first_payment_pending" && evidence.amountPaidMinorUnits > 0) {
        await tx.update(agreement).set({ status: "active" }).where(eq(agreement.id, agreementId));
        await this.recordAuditTxBound(tx, agreementId, "agreement_activated", evidence.amountPaidMinorUnits);
        return { status: "active", amountPaidMinorUnits: evidence.amountPaidMinorUnits };
      }

      return null;
    });
  }

  private async recordAuditTxBound(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    agreementId: string,
    action: string,
    amountPaidMinorUnits: number,
  ): Promise<void> {
    const secret = getServerEnv().AUDIT_HASH_SECRET;
    const payload: AuditEventPayload = {
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
    };
    await appendAuditEventTxBound(tx, payload, (previousEventHash) => computeAuditEventHash(payload, previousEventHash, secret));
  }
}
