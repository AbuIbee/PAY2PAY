import "server-only";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { AgreementCompletionChecker, PaymentAttemptRecord, PaymentAttemptRepository } from "@/lib/payments/paymentService";
import type { PaymentWebhookEventRecord, PaymentWebhookEventRepository } from "@/lib/payments/paymentWebhookService";
import type { PaymentProvider } from "@/lib/payments/paymentProvider";
import { DefaultPlatformFeePolicy, type PlatformFeePolicy } from "@/lib/payments/platformFeePolicy";
import type { AutomaticReversalEntryType, LedgerService } from "./ledgerService";

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
  | "provider_event_without_internal_state"
  // PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 1): see
  // `reconciliationExceptionTypeEnum`'s own schema doc comment.
  | "processor_fee_mismatch"
  | "platform_fee_mismatch"
  // PAID2YOU — PACKAGE B (Stage 6 final architecture closure, Item 1): a provider namespace mismatch
  // for a providerPaymentId that already resolves to an existing payment — conflicting identity
  // evidence a retry can never resolve. See `PaymentWebhookService.recordProviderIdentityMismatch`'s
  // own doc comment.
  | "provider_identity_mismatch";

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
  /**
   * PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 1 — CONFLICT EXCEPTION
   * IDEMPOTENCY): the DB-enforced-atomic counterpart to the `findOpen`-then-`insert` pair above —
   * required specifically for `PaymentWebhookService.detectAndRecordConflict`'s own automatic,
   * inline conflict detection, where two genuinely concurrent deliveries of the same conflicting
   * event must never race their way into two open exceptions. Backed by a real partial unique index
   * (`(payment_attempt_id, provider_event_id, exception_type) WHERE status = 'open'`) and
   * `INSERT ... ON CONFLICT DO NOTHING` — never a separate read followed by a separate write. Returns
   * the newly-inserted record, or `null` when an open exception with this exact identity already
   * existed (a safe, idempotent no-op — never a duplicate, never an error).
   */
  ensureOpenException(input: {
    exceptionType: ReconciliationExceptionType;
    paymentAttemptId: string;
    providerEventId: string;
    details: unknown;
  }): Promise<ReconciliationExceptionRecord | null>;
}

const STALE_PENDING_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000; // 5 days — see class doc comment.

/**
 * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 4B): a fixed, bounded backoff — not
 * exponential (a deliberate simplification; see this fix's own final report) — applied to a candidate
 * whose automatic repair attempt was blocked (missing/ambiguous evidence, or a transient error), so
 * `listMissingClearingCandidates`/`listMissingReversalCandidates` defer it rather than re-selecting
 * the SAME oldest-but-unrepairable rows on every scheduler run, which would starve a later,
 * genuinely-repairable candidate behind them. A permanently-blocked row keeps reappearing at this
 * fixed cadence forever (visible via its still-open `reconciliation_exception`, per requirement) —
 * never permanently excluded, just never allowed to monopolize every single run.
 */
const FINANCIAL_REPAIR_BACKOFF_MS = 60 * 60 * 1000; // 1 hour.

/** PACKAGE B — remaining Codex blockers (Section 4): a required financial field must be PRESENT with a valid numeric (non-negative integer) representation — never merely "a number", and never silently defaulted when absent. */
function isValidAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isValidFee(value: unknown): value is number {
  return isValidAmount(value);
}

/**
 * R09: payment status -> the ledger reversal entry type that status implies must exist.
 * R09 corrective pass (Codex blocker 8): "reversed" was missing entirely — a payment whose status
 * legitimately reached "reversed" (see `ALLOWED_SOURCE_STATUSES_FOR_DESTINATION` in paymentService.ts)
 * had no automatic-repair path for its ledger reversal entry at all. "returned" and "reversed" both
 * map to the ledger's own "reversal" entry type (see `EVENT_TYPE_TO_REVERSAL_ENTRY` in
 * paymentWebhookService.ts) — `tryRepairMissingReversalEntry`'s own `eventTypeByEntryType` already
 * disambiguates which trusted event type to look for based on `payment.status`.
 */
const REVERSAL_STATUS_TO_ENTRY_TYPE: Partial<Record<PaymentAttemptRecord["status"], AutomaticReversalEntryType>> = {
  refunded: "refund",
  returned: "reversal",
  reversed: "reversal",
  disputed: "dispute_adjustment",
};

/**
 * Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md) reconciliation between internal
 * records and provider events. Covers all 10 of the sprint's required exception types with live
 * detection logic (documented per-check below); nothing is silently ignored (requirement #9) and
 * every check is safe to re-run any number of times against the same data (requirement #10) because
 * every detection is a pure read followed by an idempotent `recordException` call.
 *
 * R09 (payment -> ledger -> agreement-lifecycle consistency/recovery) — corrective pass: merely
 * detecting `internal_posting_failure` (a required ledger entry missing under an already-succeeded
 * payment) was not sufficient — see `tryRepairMissingLedgerEntry`'s own doc comment for the SAFE
 * AUTOMATIC REPAIR this class now attempts first, before ever recording that exception, and for
 * exactly which cases are deliberately left as MANUAL-REVIEW instead. `completion` (optional, so
 * every pre-R09 test omitting it is unaffected) lets this class also opportunistically retry a
 * missed agreement-lifecycle consequence — safe to call unconditionally because
 * `AgreementCompletionService.checkAndAdvance` is already idempotent by construction (see that
 * class's own doc comment).
 */
export class ReconciliationService {
  constructor(
    private readonly deps: {
      payments: PaymentAttemptRepository;
      webhookEvents: PaymentWebhookEventRepository;
      provider: PaymentProvider;
      ledger: LedgerService;
      exceptions: ReconciliationExceptionRepository;
      /** R09 addition: opportunistic, idempotent lifecycle-convergence retry — see this class's own doc comment. */
      completion?: AgreementCompletionChecker;
      /**
       * PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 5 — RECONCILIATION MUST USE
       * PAID2YOU PLATFORM-FEE AUTHORITY): the SAME centralized policy `PaymentWebhookService`'s normal
       * webhook-receipt ledger posting and `FailedPaymentRetryCoordinator`'s ambiguity resolution both
       * use — automatic clearing repair (`tryRepairMissingLedgerEntry`) must NEVER read
       * `platformFeeMinorUnits` from an inbound provider payload (even a `source = "provider_lookup"`
       * event whose own persisted value happens to already agree — that value's own truthfulness is
       * never re-derived from an arbitrary payload field here). Defaults to `DefaultPlatformFeePolicy`
       * (today's actual authoritative rule) so every pre-existing test/production call site is
       * unaffected — the default IS the real production behavior, not a test-only stand-in.
       */
      platformFeePolicy?: PlatformFeePolicy;
    },
  ) {
    this.platformFeePolicy = deps.platformFeePolicy ?? new DefaultPlatformFeePolicy();
  }

  private readonly platformFeePolicy: PlatformFeePolicy;

  /**
   * Per-payment checks: missing_provider_transaction, unmatched_provider_transaction,
   * status_mismatch, amount_mismatch, currency_mismatch, internal_posting_failure,
   * stale_pending_settlement, reversal_refund_mismatch.
   */
  async reconcilePaymentAttempt(paymentAttemptId: string): Promise<ReconciliationExceptionRecord[]> {
    const payment = await this.deps.payments.findById(paymentAttemptId);
    if (!payment) throw new ValidationError("Payment not found.");

    const found: ReconciliationExceptionRecord[] = [];

    // missing_provider_transaction: something was submitted (not merely pending/scheduled) but we
    // never captured a provider reference. "scheduled" (Sprint 11) is deliberately excluded — a
    // scheduled-but-not-yet-submitted ACH payment legitimately has no provider reference yet.
    if (!["pending", "scheduled"].includes(payment.status) && !payment.providerPaymentId) {
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

    // internal_posting_failure / reversal-side repair / lifecycle convergence — see
    // `repairFinancialEffectsForCandidate`'s own doc comment; this admin-triggered path runs the
    // EXACT same bounded, evidence-gated repair the automatic scheduler does.
    found.push(...(await this.repairFinancialEffectsForCandidate(payment, new Date())));

    // stale_pending_settlement: still pending well past a realistic settlement window.
    if (payment.status === "pending" && Date.now() - payment.createdAt.getTime() > STALE_PENDING_THRESHOLD_MS) {
      found.push(
        await this.recordException("stale_pending_settlement", payment.id, null, {
          createdAt: payment.createdAt.toISOString(),
        }),
      );
    }

    // reversal_refund_mismatch: a reversing ledger entry exists but the payment's own status was
    // never updated to match. Derived from `REVERSAL_STATUS_TO_ENTRY_TYPE` itself (rather than a
    // separately hand-maintained list) specifically so "reversal" — shared by both "returned" and
    // "reversed" — is checked against the full set of statuses that legitimately produce it, not just
    // one (see that map's own doc comment for the R09 corrective-pass "reversed" gap this closes).
    const entryTypeToValidStatuses = new Map<AutomaticReversalEntryType, Set<PaymentAttemptRecord["status"]>>();
    for (const [status, entryType] of Object.entries(REVERSAL_STATUS_TO_ENTRY_TYPE) as [PaymentAttemptRecord["status"], AutomaticReversalEntryType][]) {
      const set = entryTypeToValidStatuses.get(entryType) ?? new Set<PaymentAttemptRecord["status"]>();
      set.add(status);
      entryTypeToValidStatuses.set(entryType, set);
    }
    for (const [entryType, validStatuses] of entryTypeToValidStatuses) {
      const entry = await this.deps.ledger.findEntry(payment.id, entryType);
      if (entry && !validStatuses.has(payment.status)) {
        found.push(
          await this.recordException("reversal_refund_mismatch", payment.id, null, {
            entryType,
            expectedStatuses: [...validStatuses],
            actualStatus: payment.status,
          }),
        );
      }
    }

    return found;
  }

  /**
   * R09 SAFE AUTOMATIC REPAIR: reconstructs and re-posts a missing `payment_cleared` ledger entry
   * from AUTHORITATIVE, already-trusted data only — never fabricating an amount or fee split. Two
   * sources qualify: (1) a manual off-platform payment, whose gross amount IS the payment record's
   * own `amountMinorUnits` with no fees by construction (see PaymentService
   * .recordManualOffPlatformPayment's own doc comment); (2) a provider-routed payment, whose fee
   * breakdown is only ever knowable from the ORIGINAL, already-processed "payment.succeeded" webhook
   * payload for it — if no such trusted event can be found, repair is correctly refused (falls back
   * to a manual-review exception) rather than guessing zero fees for a payment that might have had
   * real ones. `LedgerService.postPaymentCleared` is itself idempotent, so this can never double-post
   * even if called again by a later reconciliation pass.
   */
  /**
   * PACKAGE B — remaining Codex blockers (Section 4 — reconciliation evidence must be complete,
   * exact, bounded). The manual/off-platform branch and the provider-routed branch use ENTIRELY
   * SEPARATE evidence rules — never mixed:
   *   - manual/off-platform: the trusted INTERNAL payment record itself is sufficient (its gross
   *     amount IS `amountMinorUnits`, with zero platform/provider fee by explicit product invariant
   *     — see `PaymentService.recordManualOffPlatformPayment`'s own doc comment).
   *   - provider-routed: requires exactly ONE unambiguous, signature-verified, already-processed
   *     trusted event for this EXACT `(payment.providerName, payment.providerPaymentId, eventType)`
   *     — the required PROVIDER-authoritative financial fields (amount, currency, processor fee) must
   *     be PRESENT with a valid numeric representation and EXACTLY match; a missing field is refused
   *     exactly like a wrong one (never defaulted/invented — see `SandboxPaymentProvider
   *     .parseWebhookEvent`'s own doc comment for why "fee absent" cannot happen for a payload this
   *     codebase itself trusts). PAID2YOU — PACKAGE B (Stage 9 remediation, Root Correction 5):
   *     `platformFeeMinorUnits` is NEVER read from this (or any) inbound payload — the provider is not
   *     the authority for Paid2You's own fee, even for a `source = "provider_lookup"` event whose own
   *     persisted value happens to already agree (it was itself only ever internally derived from this
   *     SAME policy — see `platformFeePolicy`'s own doc comment) — it always comes fresh from
   *     `platformFeePolicy`, the single centralized Paid2You authority.
   */
  private async tryRepairMissingLedgerEntry(payment: PaymentAttemptRecord): Promise<boolean> {
    if (!payment.agreementId) return false; // nothing to post against — genuinely needs manual review.
    try {
      if (payment.paymentMethod === "manual_off_platform") {
        await this.deps.ledger.postPaymentCleared({
          paymentAttemptId: payment.id,
          agreementId: payment.agreementId,
          currency: payment.currency,
          grossAmountMinorUnits: payment.amountMinorUnits,
        });
        return true;
      }
      if (!payment.providerName || !payment.providerPaymentId) return false;
      const trustedEvent = await this.findUnambiguousTrustedEvent(payment.providerName, payment.providerPaymentId, "payment.succeeded");
      if (!trustedEvent) return false;
      const payload = trustedEvent.payload as Record<string, unknown>;

      // Every required PROVIDER-authoritative field must be PRESENT and valid — a missing field is
      // refused, never defaulted.
      if (!isValidAmount(payload.amountMinorUnits) || payload.amountMinorUnits !== payment.amountMinorUnits) return false;
      if (typeof payload.currency !== "string" || payload.currency !== payment.currency) return false;
      if (!isValidFee(payload.processorFeeMinorUnits)) return false;
      const processorFeeMinorUnits = payload.processorFeeMinorUnits as number;
      const platformFeeMinorUnits = await this.platformFeePolicy.getPlatformFeeMinorUnits({
        amountMinorUnits: payment.amountMinorUnits,
        currency: payment.currency,
        paymentMethod: payment.paymentMethod,
        agreementId: payment.agreementId,
      });
      if (processorFeeMinorUnits + platformFeeMinorUnits > payment.amountMinorUnits) return false; // fee <= gross.

      await this.deps.ledger.postPaymentCleared({
        paymentAttemptId: payment.id,
        agreementId: payment.agreementId,
        currency: payment.currency,
        grossAmountMinorUnits: payment.amountMinorUnits,
        processorFeeMinorUnits,
        platformFeeMinorUnits,
      });
      return true;
    } catch (error) {
      logger.error("reconciliation_ledger_repair_failed", {
        paymentAttemptId: payment.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * R09 SAFE AUTOMATIC REPAIR: the reversal-entry counterpart to `tryRepairMissingLedgerEntry` — see
   * its own doc comment for the identical strict-evidence rules this applies. Only ever reconstructed
   * from the trusted, already-processed webhook event that drove this payment to its current
   * (refunded/returned/disputed/reversed) status; refuses (manual review) on any mismatch, missing
   * field, or ambiguity.
   *
   * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 6): `amountMinorUnits`/`currency`
   * are now REQUIRED PRESENT fields, exactly like the clearing-repair path — never "checked only if
   * present." `LedgerService.reversePayment` has no partial-amount parameter anywhere in this
   * codebase; it always reverses the clearing entry's FULL gross amount. Absence of an amount field is
   * therefore never proof of "a full reversal was intended" — it is simply missing evidence, and a
   * missing field is refused exactly like a wrong one, never defaulted/inferred (manual-review
   * exception retained).
   */
  private async tryRepairMissingReversalEntry(payment: PaymentAttemptRecord, entryType: AutomaticReversalEntryType): Promise<boolean> {
    if (!payment.providerName || !payment.providerPaymentId) return false;
    const eventTypeByEntryType: Record<AutomaticReversalEntryType, string> = {
      refund: "payment.refunded",
      reversal: payment.status === "returned" ? "payment.returned" : "payment.reversed",
      dispute_adjustment: "payment.disputed",
    };
    try {
      const trustedEvent = await this.findUnambiguousTrustedEvent(payment.providerName, payment.providerPaymentId, eventTypeByEntryType[entryType]);
      if (!trustedEvent) return false;
      const payload = trustedEvent.payload as Record<string, unknown>;
      // Every required field must be PRESENT and valid — a missing field is refused, never defaulted
      // — matching this payment's own recorded gross amount/currency (the only reversal shape this
      // codebase's ledger actually implements: a full reversal of the original clearing entry).
      if (!isValidAmount(payload.amountMinorUnits) || payload.amountMinorUnits !== payment.amountMinorUnits) return false;
      if (typeof payload.currency !== "string" || payload.currency !== payment.currency) return false;
      const reason = typeof payload.reason === "string" ? payload.reason : null;
      await this.deps.ledger.reversePayment({ paymentAttemptId: payment.id, entryType, reason });
      return true;
    } catch (error) {
      logger.error("reconciliation_ledger_repair_failed", {
        paymentAttemptId: payment.id,
        entryType,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * R09 corrective pass (Codex blocker 8): the ONLY sanctioned evidence lookup for automatic repair —
   * `PaymentWebhookEventRepository.findTrustedFinancialEventsForPayment`'s indexed, provider-scoped,
   * bounded (`LIMIT 2`) query — keyed on `payment.providerName` (never merely the currently-configured
   * provider instance, per Codex's own requirement) — NEVER `listAll()`. Zero candidates means nothing
   * to repair from; more than one is genuine ambiguity — both cases refuse repair rather than guess.
   */
  private async findUnambiguousTrustedEvent(providerName: string, providerPaymentId: string, eventType: string): Promise<PaymentWebhookEventRecord | null> {
    const candidates = await this.deps.webhookEvents.findTrustedFinancialEventsForPayment(providerName, providerPaymentId, eventType);
    if (candidates.length !== 1) return null;
    return candidates[0]!;
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

  /**
   * PACKAGE B — remaining Codex blockers (Section 1 — the actual REPAIR subset of
   * `reconcilePaymentAttempt`, factored out so the automatic scheduler path can call it WITHOUT ever
   * running the admin-scan-only checks above that depend on `webhookEvents.listAll()`
   * (amount_mismatch/currency_mismatch) or a live provider round-trip
   * (unmatched_provider_transaction/status_mismatch). Every step here is either a single indexed
   * `ledger.findEntry` lookup or the bounded, evidence-gated repair methods themselves — never an
   * unbounded scan. Idempotent and safe to call repeatedly: `LedgerService`'s own get-or-post methods
   * and `AgreementCompletionService.checkAndAdvance` are already idempotent by construction.
   */
  private async repairFinancialEffectsForCandidate(payment: PaymentAttemptRecord, now: Date, respectBackoff = false): Promise<ReconciliationExceptionRecord[]> {
    const found: ReconciliationExceptionRecord[] = [];
    // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 4B — a gap found and fixed this
    // round): `listMissingClearingCandidates`/`listMissingReversalCandidates` already filter on
    // `financialRepairNextAttemptAt`, but `listLifecycleRepairCandidates` (a DIFFERENT concern, no
    // backoff of its own) can ALSO surface the exact same payment row — `repairBatch` merges all
    // three candidate sets, so without this guard a backoff-deferred row would sneak its financial
    // repair attempt back in via the lifecycle query alone, defeating the whole point of deferring it.
    // Checked here, not at the query level, so the SAME method still runs unconditionally (no backoff)
    // for `reconcilePaymentAttempt`'s admin-triggered, single-payment manual path.
    const financialRepairDeferred = respectBackoff && !!payment.financialRepairNextAttemptAt && payment.financialRepairNextAttemptAt.getTime() > now.getTime();

    if (payment.status === "succeeded" && !financialRepairDeferred) {
      const clearEntry = await this.deps.ledger.findEntry(payment.id, "payment_cleared");
      if (!clearEntry) {
        const repaired = await this.tryRepairMissingLedgerEntry(payment);
        if (!repaired) {
          found.push(await this.recordException("internal_posting_failure", payment.id, null, { status: payment.status }));
          // PAID2YOU — PACKAGE B (Section 4B): defer — never re-select this same blocked row again
          // until the backoff elapses, so a later, genuinely-repairable candidate isn't starved.
          await this.deps.payments.markFinancialRepairDeferred(payment.id, new Date(now.getTime() + FINANCIAL_REPAIR_BACKOFF_MS));
        }
      }
    }

    const reversalEntryTypeNeeded = REVERSAL_STATUS_TO_ENTRY_TYPE[payment.status];
    if (reversalEntryTypeNeeded && !financialRepairDeferred) {
      const entry = await this.deps.ledger.findEntry(payment.id, reversalEntryTypeNeeded);
      if (!entry) {
        const repaired = await this.tryRepairMissingReversalEntry(payment, reversalEntryTypeNeeded);
        if (!repaired) {
          found.push(
            await this.recordException("internal_posting_failure", payment.id, null, {
              status: payment.status,
              missingEntryType: reversalEntryTypeNeeded,
            }),
          );
          await this.deps.payments.markFinancialRepairDeferred(payment.id, new Date(now.getTime() + FINANCIAL_REPAIR_BACKOFF_MS));
        }
      }
    }

    // Opportunistic, idempotent lifecycle-convergence retry — safe to call unconditionally (a no-op
    // if already advanced, or not currently eligible) whenever this payment has actually cleared and
    // has an agreement to advance.
    //
    // PACKAGE B — PRE-CODEX FINAL CORRECTION (item 3): `markLifecycleChecked` is called ONLY after
    // `checkAndAdvance` returns without throwing — see that method's own doc comment for why this,
    // not agreement status, is what makes `listLifecycleRepairCandidates` self-shrinking. A genuine
    // failure here (caught and logged below, as before) leaves the row unmarked and still eligible
    // for the next scheduler run, exactly like every other repair failure in this file.
    if (this.deps.completion && payment.agreementId && payment.status === "succeeded") {
      const clearEntryNow = await this.deps.ledger.findEntry(payment.id, "payment_cleared");
      if (clearEntryNow) {
        try {
          await this.deps.completion.checkAndAdvance(payment.agreementId);
          await this.deps.payments.markLifecycleChecked(payment.id, new Date());
        } catch (error) {
          logger.error("reconciliation_lifecycle_repair_failed", {
            paymentAttemptId: payment.id,
            agreementId: payment.agreementId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return found;
  }

  /**
   * R09 corrective pass (Codex blocker 1 — automatic reconciliation/convergence), PACKAGE B —
   * remaining Codex blockers (Section 1 — bounded AND eventually complete): the scheduler's bounded,
   * indexed, self-shrinking candidate queries — `listMissingClearingCandidates`/
   * `listMissingReversalCandidates` (oldest-updated first) — NEVER `listAll()`, and NEVER a
   * "most-recently-updated" scan that could starve an old genuinely-unresolved row behind newer,
   * already-fine ones. Runs `repairFinancialEffectsForCandidate` — the exact same bounded,
   * evidence-gated repair `reconcilePaymentAttempt` performs, minus its `listAll()`-dependent
   * detection-only checks — covering ALL of Codex's named statuses (succeeded, refunded, returned,
   * reversed, disputed), not merely "succeeded". Bounded and retry-safe: every underlying repair is
   * independently idempotent, so running this again (from this or any other concurrent scheduler
   * invocation) is always safe, and because a repaired row drops out of both candidate queries
   * entirely, repeated bounded calls are guaranteed to eventually cover every genuinely unresolved
   * row without a separate durable cursor.
   */
  async repairBatch(limit: number, now: Date = new Date()): Promise<{ scanned: number; exceptionsFound: number }> {
    const [missingClearing, missingReversal, lifecycleCandidates] = await Promise.all([
      this.deps.payments.listMissingClearingCandidates(limit, now),
      this.deps.payments.listMissingReversalCandidates(limit, now),
      this.deps.payments.listLifecycleRepairCandidates(limit),
    ]);
    const candidates = new Map<string, PaymentAttemptRecord>();
    for (const payment of [...missingClearing, ...missingReversal, ...lifecycleCandidates]) {
      candidates.set(payment.id, payment);
    }
    let exceptionsFound = 0;
    for (const payment of candidates.values()) {
      const found = await this.repairFinancialEffectsForCandidate(payment, now, true);
      exceptionsFound += found.length;
    }
    return { scanned: candidates.size, exceptionsFound };
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
