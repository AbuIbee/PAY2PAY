import "server-only";
import { ValidationError } from "@/lib/errors";
import type { PaymentAttemptRecord, PaymentAttemptRepository } from "@/lib/payments/paymentService";
import type { PaymentWebhookEventRepository } from "@/lib/payments/paymentWebhookService";
import type { PaymentProvider } from "@/lib/payments/paymentProvider";
import type { LedgerService } from "./ledgerService";

export type ReconciliationExceptionType =
  | "missing_provider_transaction"
  | "unmatched_provider_transaction"
  | "amount_mismatch"
  | "currency_mismatch"
  | "duplicate_transaction"
  | "status_mismatch"
  | "reversal_refund_mismatch"
  | "stale_pending_settlement"
  | "internal_posting_failure"
  | "provider_event_without_internal_state";

export interface ReconciliationExceptionRecord {
  id: string;
  exceptionType: ReconciliationExceptionType;
  paymentAttemptId: string | null;
  providerEventId: string | null;
  details: unknown;
  status: "open" | "resolved";
  detectedAt: Date;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  resolutionReason: string | null;
}

/**
 * Sprint 10 requirement #9/#10: exceptions are explicit persisted records, and re-running
 * reconciliation must not create duplicates. `findOpen` is the idempotency check —
 * ReconciliationService always calls it before `insert`. This is an application-level check
 * (find-then-insert), not a DB partial-unique-index, because `payment_attempt_id` and
 * `provider_event_id` are each independently nullable depending on exception type (a DB unique
 * index over a mixed-nullable tuple needs a partial index whose Drizzle-version support this
 * project hasn't otherwise depended on) — reconciliation is an administrative/batch operation, not
 * a concurrent-request hot path, so the race window this leaves is acceptable and documented.
 */
export interface ReconciliationExceptionRepository {
  findOpen(
    exceptionType: ReconciliationExceptionType,
    paymentAttemptId: string | null,
    providerEventId: string | null,
  ): Promise<ReconciliationExceptionRecord | null>;
  insert(input: {
    exceptionType: ReconciliationExceptionType;
    paymentAttemptId: string | null;
    providerEventId: string | null;
    details: unknown;
  }): Promise<ReconciliationExceptionRecord>;
  listOpen(): Promise<ReconciliationExceptionRecord[]>;
  listForPaymentAttempt(paymentAttemptId: string): Promise<ReconciliationExceptionRecord[]>;
  resolve(id: string, resolvedByUserId: string, resolutionReason: string): Promise<ReconciliationExceptionRecord>;
}

const STALE_PENDING_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000; // 5 days — see class doc comment.

/**
 * Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md) reconciliation between internal
 * records and provider events. Covers all 10 of the sprint's required exception types with live
 * detection logic (documented per-check below); nothing is silently ignored (requirement #9) and
 * every check is safe to re-run any number of times against the same data (requirement #10) because
 * every detection is a pure read followed by an idempotent `recordException` call.
 */
export class ReconciliationService {
  constructor(
    private readonly deps: {
      payments: PaymentAttemptRepository;
      webhookEvents: PaymentWebhookEventRepository;
      provider: PaymentProvider;
      ledger: LedgerService;
      exceptions: ReconciliationExceptionRepository;
    },
  ) {}

  /**
   * Per-payment checks: missing_provider_transaction, unmatched_provider_transaction,
   * status_mismatch, amount_mismatch, currency_mismatch, internal_posting_failure,
   * stale_pending_settlement, reversal_refund_mismatch.
   */
  async reconcilePaymentAttempt(paymentAttemptId: string): Promise<ReconciliationExceptionRecord[]> {
    const payment = await this.deps.payments.findById(paymentAttemptId);
    if (!payment) throw new ValidationError("Payment not found.");

    const found: ReconciliationExceptionRecord[] = [];

    // missing_provider_transaction: something happened (not pending) but we never captured a provider reference.
    if (payment.status !== "pending" && !payment.providerPaymentId) {
      found.push(await this.recordException("missing_provider_transaction", payment.id, null, { status: payment.status }));
    }

    if (payment.providerPaymentId) {
      // unmatched_provider_transaction: we hold a provider reference the provider itself doesn't recognize.
      let providerStatus: string | null = null;
      try {
        const retrieved = await this.deps.provider.retrievePayment(payment.providerPaymentId);
        providerStatus = retrieved.status;
      } catch {
        found.push(
          await this.recordException("unmatched_provider_transaction", payment.id, null, {
            providerPaymentId: payment.providerPaymentId,
          }),
        );
      }
      // status_mismatch: only meaningful for the three statuses the provider's own (simplified) status vocabulary can represent.
      if (providerStatus && ["pending", "succeeded", "failed"].includes(payment.status) && providerStatus !== payment.status) {
        found.push(
          await this.recordException("status_mismatch", payment.id, null, {
            ourStatus: payment.status,
            providerStatus,
          }),
        );
      }
    }

    // amount_mismatch / currency_mismatch: cross-check every webhook event that references this payment.
    if (payment.providerPaymentId) {
      const allEvents = await this.deps.webhookEvents.listAll();
      for (const event of allEvents) {
        const payload = event.payload as Record<string, unknown>;
        if (payload.providerPaymentId !== payment.providerPaymentId) continue;
        if (typeof payload.amountMinorUnits === "number" && payload.amountMinorUnits !== payment.amountMinorUnits) {
          found.push(
            await this.recordException("amount_mismatch", payment.id, event.providerEventId, {
              expected: payment.amountMinorUnits,
              actual: payload.amountMinorUnits,
            }),
          );
        }
        if (typeof payload.currency === "string" && payload.currency !== payment.currency) {
          found.push(
            await this.recordException("currency_mismatch", payment.id, event.providerEventId, {
              expected: payment.currency,
              actual: payload.currency,
            }),
          );
        }
      }
    }

    // internal_posting_failure: our own status says it cleared, but the ledger has no record of it.
    if (payment.status === "succeeded") {
      const clearEntry = await this.deps.ledger.findEntry(payment.id, "payment_cleared");
      if (!clearEntry) {
        found.push(await this.recordException("internal_posting_failure", payment.id, null, { status: payment.status }));
      }
    }

    // stale_pending_settlement: still pending well past a realistic settlement window.
    if (payment.status === "pending" && Date.now() - payment.createdAt.getTime() > STALE_PENDING_THRESHOLD_MS) {
      found.push(
        await this.recordException("stale_pending_settlement", payment.id, null, {
          createdAt: payment.createdAt.toISOString(),
        }),
      );
    }

    // reversal_refund_mismatch: a reversing ledger entry exists but the payment's own status was never updated to match.
    const reversalChecks: { entryType: "refund" | "reversal" | "dispute_adjustment"; expectedStatus: PaymentAttemptRecord["status"] }[] = [
      { entryType: "refund", expectedStatus: "refunded" },
      { entryType: "reversal", expectedStatus: "reversed" },
      { entryType: "dispute_adjustment", expectedStatus: "disputed" },
    ];
    for (const check of reversalChecks) {
      const entry = await this.deps.ledger.findEntry(payment.id, check.entryType);
      if (entry && payment.status !== check.expectedStatus) {
        found.push(
          await this.recordException("reversal_refund_mismatch", payment.id, null, {
            entryType: check.entryType,
            expectedStatus: check.expectedStatus,
            actualStatus: payment.status,
          }),
        );
      }
    }

    return found;
  }

  /**
   * System-wide checks that only make sense scanning everything at once: duplicate_transaction
   * (more than one payment_attempt sharing a provider_payment_id — defensive; the DB unique
   * constraint already prevents this via the normal application path) and
   * provider_event_without_internal_state (a webhook event whose provider_payment_id matches no
   * payment_attempt at all). Also runs reconcilePaymentAttempt for every payment.
   */
  async reconcileAll(): Promise<ReconciliationExceptionRecord[]> {
    const [payments, events] = await Promise.all([this.deps.payments.listAll(), this.deps.webhookEvents.listAll()]);
    const found: ReconciliationExceptionRecord[] = [];

    for (const payment of payments) {
      found.push(...(await this.reconcilePaymentAttempt(payment.id)));
    }

    const byProviderPaymentId = new Map<string, PaymentAttemptRecord[]>();
    for (const payment of payments) {
      if (!payment.providerPaymentId) continue;
      const list = byProviderPaymentId.get(payment.providerPaymentId) ?? [];
      list.push(payment);
      byProviderPaymentId.set(payment.providerPaymentId, list);
    }
    for (const [providerPaymentId, group] of byProviderPaymentId) {
      if (group.length <= 1) continue;
      for (const payment of group) {
        found.push(
          await this.recordException("duplicate_transaction", payment.id, null, {
            providerPaymentId,
            siblingCount: group.length - 1,
          }),
        );
      }
    }

    const knownProviderPaymentIds = new Set(payments.map((p) => p.providerPaymentId).filter((id): id is string => id !== null));
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      const providerPaymentId = typeof payload.providerPaymentId === "string" ? payload.providerPaymentId : null;
      if (providerPaymentId && !knownProviderPaymentIds.has(providerPaymentId)) {
        found.push(
          await this.recordException("provider_event_without_internal_state", null, event.providerEventId, {
            providerPaymentId,
            eventType: event.eventType,
          }),
        );
      }
    }

    return found;
  }

  async listOpenExceptions(): Promise<ReconciliationExceptionRecord[]> {
    return this.deps.exceptions.listOpen();
  }

  async listExceptionsForPaymentAttempt(paymentAttemptId: string): Promise<ReconciliationExceptionRecord[]> {
    return this.deps.exceptions.listForPaymentAttempt(paymentAttemptId);
  }

  async resolveException(id: string, resolvedByUserId: string, resolutionReason: string): Promise<ReconciliationExceptionRecord> {
    if (!resolutionReason.trim()) {
      throw new ValidationError("A resolution reason is required.");
    }
    return this.deps.exceptions.resolve(id, resolvedByUserId, resolutionReason);
  }

  private async recordException(
    exceptionType: ReconciliationExceptionType,
    paymentAttemptId: string | null,
    providerEventId: string | null,
    details: unknown,
  ): Promise<ReconciliationExceptionRecord> {
    const existing = await this.deps.exceptions.findOpen(exceptionType, paymentAttemptId, providerEventId);
    if (existing) return existing;
    return this.deps.exceptions.insert({ exceptionType, paymentAttemptId, providerEventId, details });
  }
}
