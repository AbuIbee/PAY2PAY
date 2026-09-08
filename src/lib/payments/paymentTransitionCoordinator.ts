import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { paymentAttempt, paymentWebhookEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PaymentAttemptRecord, PaymentAttemptStatus } from "./paymentService";

type PaymentAttemptRow = typeof paymentAttempt.$inferSelect;

function toPaymentRecord(row: PaymentAttemptRow): PaymentAttemptRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    payerProfileKind: row.payerProfileKind,
    payerProfileId: row.payerProfileId,
    recipientProfileKind: row.recipientProfileKind,
    recipientProfileId: row.recipientProfileId,
    amountMinorUnits: row.amountMinorUnits,
    currency: row.currency,
    agreementId: row.agreementId,
    status: row.status,
    providerName: row.providerName,
    providerPaymentId: row.providerPaymentId,
    failureReason: row.failureReason,
    payoutCompletedAt: row.payoutCompletedAt,
    payoutInitiatedAt: row.payoutInitiatedAt,
    installmentScheduleItemId: row.installmentScheduleItemId,
    paymentMethod: row.paymentMethod,
    recordedByUserId: row.recordedByUserId,
    recipientConfirmedAt: row.recipientConfirmedAt,
    bankConnectionId: row.bankConnectionId,
    lifecycleCheckedAt: row.lifecycleCheckedAt,
    financialRepairNextAttemptAt: row.financialRepairNextAttemptAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 5). Thrown when the transition
 * marker's own `UPDATE ... WHERE id = ? AND claim_token = ?` affects ZERO rows — this claim has been
 * lost (the lease expired and a different worker already reclaimed this webhook event, minting a
 * fresh `claimToken`, between this worker starting its transaction and reaching this write). This is
 * a genuine CONCURRENCY/coordination condition, never a permanent data defect — `classifyProcessingFailure`
 * must classify it as retryable (it deliberately extends neither `FinancialIntegrityError` nor
 * `ValidationError`/`ConfigurationError`, falling through to that function's retryable default), so
 * the current worker's already-buffered payment-status update rolls back with it (see
 * `applyTransition`'s own doc comment) and the event remains eligible for whichever worker now
 * legitimately owns it to process to completion.
 */
export class StaleTransitionClaimError extends Error {
  constructor(message = "payment_webhook_stale_transition_claim") {
    super(message);
    this.name = "StaleTransitionClaimError";
  }
}

export type TransitionApplyResult =
  | { outcome: "applied"; payment: PaymentAttemptRecord; fromStatus: PaymentAttemptStatus }
  /** The transition was NEVER applied by this call — `payment` is the authoritative current row, read under the same lock. */
  | { outcome: "rejected"; payment: PaymentAttemptRecord };

/**
 * PACKAGE B — remaining Codex blockers (durable provider-event transition progress, the central
 * remaining R06/R09 defect). Closes the exact race Codex named: a refund event begins while a
 * payment is "pending" (illegal — refund requires "succeeded" first); without this class, nothing
 * durably records that the refund's OWN transition never happened, so a later retry of that same
 * refund event — even after an unrelated "succeeded" event has since posted — has no way to tell
 * "did MY transition ever apply" apart from "what does the payment's CURRENT status happen to be
 * right now" (which could have been changed by a completely different, later event).
 *
 * `applyTransition` does three things atomically, in ONE transaction, so a crash between any of them
 * is structurally impossible:
 *   1. locks the `payment_attempt` row (`SELECT ... FOR UPDATE`) and reads its authoritative CURRENT
 *      status;
 *   2. validates that status against `allowedSourceStatuses` (the caller's own
 *      `ALLOWED_SOURCE_STATUSES_FOR_DESTINATION[newStatus]`) — if illegal, updates NOTHING and reports
 *      "rejected" (this event's transition remains durably un-applied);
 *   3. if legal, updates the payment's status AND persists, on this EXACT webhook event row, the
 *      `transition_from_status`/`transition_to_status`/`transition_applied_at` triple — the durable,
 *      per-event record of "this event's transition did happen, and here is exactly what it was."
 *
 * `PaymentWebhookService.applyEvent` never re-derives "did my transition apply" from current status
 * again once this has run: a webhook event whose `transitionAppliedAt` is already set (from a prior
 * attempt) skips this class entirely on retry and goes straight to ensuring its OWN required
 * ledger/audit effects — using `transitionFromStatus`/`transitionToStatus` as the durable source of
 * truth for reconstructing what those effects should be, never the payment's current status (which
 * may have moved on since, e.g. to "disputed").
 */
export interface PaymentTransitionCoordinator {
  applyTransition(input: {
    paymentAttemptId: string;
    webhookEventId: string;
    claimToken: string;
    newStatus: PaymentAttemptStatus;
    fields: { providerPaymentId?: string; failureReason?: string };
    allowedSourceStatuses: readonly PaymentAttemptStatus[];
  }): Promise<TransitionApplyResult>;
}

/**
 * PACKAGE B — remaining Codex blockers: the same kind of production-safe, no-op-by-default test-only
 * affordance as `AgreementLockTestHooks`/`InstallmentLockTestHooks` (see those classes' own doc
 * comments) — lets a `*.postgres.test.ts` suite force a rollback partway through `applyTransition`'s
 * transaction to prove the payment-status update and the webhook event's transition marker are
 * genuinely atomic (both roll back together, never one without the other). Defaults to `undefined`;
 * every production call site never sets it.
 */
export interface TransitionCoordinatorTestHooks {
  /** Awaited immediately after the payment_attempt row is updated, before the webhook event's transition marker is written — throwing here rolls back the WHOLE transaction. */
  afterPaymentUpdate?: () => Promise<void>;
}

export class DrizzlePaymentTransitionCoordinator implements PaymentTransitionCoordinator {
  /**
   * R07-style injectability: `db` defaults to the shared production singleton solely so
   * `*.postgres.test.ts` concurrency suites can hand this class a genuinely distinct connection.
   * Every production call site (`new DrizzlePaymentTransitionCoordinator()`, no argument) is
   * unaffected. `hooks` is the same kind of test-only affordance — see `TransitionCoordinatorTestHooks`'s own doc comment.
   */
  constructor(
    private readonly db: Database = getDb(),
    private readonly hooks?: TransitionCoordinatorTestHooks,
  ) {}

  async applyTransition(input: {
    paymentAttemptId: string;
    webhookEventId: string;
    claimToken: string;
    newStatus: PaymentAttemptStatus;
    fields: { providerPaymentId?: string; failureReason?: string };
    allowedSourceStatuses: readonly PaymentAttemptStatus[];
  }): Promise<TransitionApplyResult> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(paymentAttempt).where(eq(paymentAttempt.id, input.paymentAttemptId)).for("update").limit(1);
      const row = rows[0];
      if (!row) throw new ConfigurationError("payment_attempt not found during transition coordination");
      const current = toPaymentRecord(row);

      if (!input.allowedSourceStatuses.includes(current.status)) {
        return { outcome: "rejected", payment: current };
      }

      const [updated] = await tx
        .update(paymentAttempt)
        .set({ status: input.newStatus, updatedAt: new Date(), ...input.fields })
        .where(eq(paymentAttempt.id, input.paymentAttemptId))
        .returning();
      if (!updated) throw new ConfigurationError("payment_attempt update returned no row during transition coordination");
      if (this.hooks?.afterPaymentUpdate) await this.hooks.afterPaymentUpdate();

      // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 5): fenced by claimToken, and
      // the affected-row-count IS checked — a stale/reclaimed claim (lease expired, a different
      // worker already reclaimed this event and minted a fresh token) must never let the payment
      // status update above commit alone. `.returning()` + a zero-row check is the only way to detect
      // "this UPDATE's WHERE clause matched nothing" with this driver; throwing here rolls back the
      // WHOLE transaction (see this class's own doc comment on `applyTransition`).
      const [markerRow] = await tx
        .update(paymentWebhookEvent)
        .set({
          transitionAppliedAt: new Date(),
          transitionFromStatus: current.status,
          transitionToStatus: input.newStatus,
        })
        .where(and(eq(paymentWebhookEvent.id, input.webhookEventId), eq(paymentWebhookEvent.claimToken, input.claimToken)))
        .returning({ id: paymentWebhookEvent.id });
      if (!markerRow) {
        throw new StaleTransitionClaimError();
      }

      return { outcome: "applied", payment: toPaymentRecord(updated), fromStatus: current.status };
    });
  }
}
