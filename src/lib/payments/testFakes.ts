import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { createTestLedgerService } from "@/lib/ledger/testFakes";
import type { NotificationService } from "@/lib/notify/notificationService";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import type { ProfileOwnerReader } from "@/lib/profiles/verificationService";
import { createTestRiskEventService } from "@/lib/risk/testFakes";
import { PaymentService } from "./paymentService";
import type {
  AgreementBalanceReader,
  AgreementCompletionChecker,
  AgreementPartiesReader,
  AtomicManualPaymentPoster,
  LedgerPoster,
  ManualPaymentInstallmentHook,
  PaymentAttemptRecord,
  PaymentAttemptRepository,
  PaymentAttemptStatus,
  PaymentMethod,
} from "./paymentService";
import type { ProfileRef } from "./paymentProvider";
import type { PaymentTransitionCoordinator, TransitionApplyResult } from "./paymentTransitionCoordinator";
import { PaymentWebhookService } from "./paymentWebhookService";
import type { ClaimOutcome, FailedPaymentWorkflow, PaymentWebhookEventRecord, PaymentWebhookEventRepository } from "./paymentWebhookService";
import { SandboxPaymentProvider } from "./sandboxPaymentProvider";

/** Test-only in-memory doubles for PaymentService, mirroring src/lib/csvImport/testFakes.ts's pattern. */

export class InMemoryPaymentAttemptRepository implements PaymentAttemptRepository {
  private byId = new Map<string, PaymentAttemptRecord>();
  private idempotencyKeys = new Set<string>();

  async insertPending(input: {
    idempotencyKey: string;
    payerProfileKind: "personal" | "business";
    payerProfileId: string;
    recipientProfileKind: "personal" | "business";
    recipientProfileId: string;
    amountMinorUnits: number;
    currency: string;
    agreementId: string | null;
    providerName: string;
    installmentScheduleItemId?: string | null;
    initialStatus?: PaymentAttemptStatus;
    paymentMethod?: PaymentMethod | null;
    recordedByUserId?: string | null;
    bankConnectionId?: string | null;
  }): Promise<PaymentAttemptRecord> {
    if (this.idempotencyKeys.has(input.idempotencyKey)) {
      throw new Error("duplicate idempotency key");
    }
    this.idempotencyKeys.add(input.idempotencyKey);
    const now = new Date();
    const { initialStatus, installmentScheduleItemId, paymentMethod, recordedByUserId, bankConnectionId, ...rest } = input;
    const record: PaymentAttemptRecord = {
      id: randomUUID(),
      status: initialStatus ?? "pending",
      providerPaymentId: null,
      failureReason: null,
      payoutCompletedAt: null,
      payoutInitiatedAt: null,
      installmentScheduleItemId: installmentScheduleItemId ?? null,
      paymentMethod: paymentMethod ?? null,
      recordedByUserId: recordedByUserId ?? null,
      recipientConfirmedAt: null,
      bankConnectionId: bankConnectionId ?? null,
      lifecycleCheckedAt: null,
      financialRepairNextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
      ...rest,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async updateStatus(
    id: string,
    status: PaymentAttemptStatus,
    fields: { providerPaymentId?: string; failureReason?: string },
  ): Promise<PaymentAttemptRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("payment_attempt not found");
    record.status = status;
    if (fields.providerPaymentId !== undefined) record.providerPaymentId = fields.providerPaymentId;
    if (fields.failureReason !== undefined) record.failureReason = fields.failureReason;
    record.updatedAt = new Date();
    return record;
  }

  /** Mirrors DrizzlePaymentAttemptRepository.updateStatusIfLegalTransition's exact contract — see that method's own doc comment. */
  async updateStatusIfLegalTransition(
    id: string,
    newStatus: PaymentAttemptStatus,
    fields: { providerPaymentId?: string; failureReason?: string },
    allowedSourceStatuses: readonly PaymentAttemptStatus[],
  ): Promise<PaymentAttemptRecord | null> {
    const record = this.byId.get(id);
    if (!record || !allowedSourceStatuses.includes(record.status)) return null;
    record.status = newStatus;
    if (fields.providerPaymentId !== undefined) record.providerPaymentId = fields.providerPaymentId;
    if (fields.failureReason !== undefined) record.failureReason = fields.failureReason;
    record.updatedAt = new Date();
    return record;
  }

  async confirmManualPayment(id: string, confirmedAt: Date): Promise<PaymentAttemptRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("payment_attempt not found");
    record.recipientConfirmedAt = confirmedAt;
    record.updatedAt = new Date();
    return record;
  }

  async findById(id: string): Promise<PaymentAttemptRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PaymentAttemptRecord | null> {
    return [...this.byId.values()].find((r) => r.idempotencyKey === idempotencyKey) ?? null;
  }

  async findByProviderPaymentId(providerPaymentId: string): Promise<PaymentAttemptRecord | null> {
    return [...this.byId.values()].find((r) => r.providerPaymentId === providerPaymentId) ?? null;
  }

  async markPayoutCompleted(id: string, payoutCompletedAt: Date): Promise<PaymentAttemptRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("payment_attempt not found");
    record.payoutCompletedAt = payoutCompletedAt;
    record.updatedAt = new Date();
    return record;
  }

  async markPayoutInitiated(id: string, payoutInitiatedAt: Date): Promise<PaymentAttemptRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("payment_attempt not found");
    record.payoutInitiatedAt = payoutInitiatedAt;
    record.updatedAt = new Date();
    return record;
  }

  async findOpenByInstallment(installmentScheduleItemId: string): Promise<PaymentAttemptRecord | null> {
    const openStatuses: PaymentAttemptStatus[] = ["pending", "scheduled", "submitted", "processing"];
    return (
      [...this.byId.values()].find(
        (r) => r.installmentScheduleItemId === installmentScheduleItemId && openStatuses.includes(r.status),
      ) ?? null
    );
  }

  async listAll(): Promise<PaymentAttemptRecord[]> {
    return [...this.byId.values()];
  }

  async listByAgreementId(agreementId: string): Promise<PaymentAttemptRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.agreementId === agreementId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listRecentByPayer(payer: ProfileRef, sinceDate: Date): Promise<PaymentAttemptRecord[]> {
    return [...this.byId.values()].filter(
      (r) => r.payerProfileKind === payer.profileKind && r.payerProfileId === payer.profileId && r.createdAt >= sinceDate,
    );
  }

  async listRecentlySucceeded(limit: number): Promise<PaymentAttemptRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.status === "succeeded")
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  /**
   * PACKAGE B — remaining Codex blockers: this in-memory fake has no visibility into ledger state at
   * all (a separate fake/service), so — unlike the real, properly `NOT EXISTS`-filtered Drizzle
   * query — this simply returns every "succeeded" payment, oldest-updated first. Correctness is still
   * enforced downstream by `ReconciliationService.reconcilePaymentAttempt`'s own
   * `ledger.findEntry(...)` check for each candidate; this fake only needs to be a safe (over-broad)
   * pre-filter, never an under-broad one.
   */
  async listMissingClearingCandidates(limit: number, now: Date): Promise<PaymentAttemptRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.status === "succeeded" && (!r.financialRepairNextAttemptAt || r.financialRepairNextAttemptAt.getTime() <= now.getTime()))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit);
  }

  async markFinancialRepairDeferred(id: string, nextAttemptAt: Date): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.financialRepairNextAttemptAt = nextAttemptAt;
  }

  /**
   * PACKAGE B — PRE-CODEX FINAL CORRECTION (item 3): mirrors the real Drizzle query's
   * `lifecycleCheckedAt IS NULL` filter exactly (not merely over-broad here — this fake has no
   * ledger-state visibility to fall back on for correctness the way `listMissingClearingCandidates`
   * does, so it must itself be precise about the one thing that makes this self-shrinking).
   */
  async listLifecycleRepairCandidates(limit: number): Promise<PaymentAttemptRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.status === "succeeded" && r.agreementId && !r.lifecycleCheckedAt)
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit);
  }

  async markLifecycleChecked(id: string, checkedAt: Date): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.lifecycleCheckedAt = checkedAt;
  }

  /** Same rationale as `listMissingClearingCandidates` — see its own doc comment. */
  async listMissingReversalCandidates(limit: number, now: Date): Promise<PaymentAttemptRecord[]> {
    return [...this.byId.values()]
      .filter(
        (r) =>
          (r.status === "refunded" || r.status === "returned" || r.status === "reversed" || r.status === "disputed") &&
          (!r.financialRepairNextAttemptAt || r.financialRepairNextAttemptAt.getTime() <= now.getTime()),
      )
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit);
  }

  /** Test-only helper (not part of PaymentAttemptRepository) — backdates a record for staleness tests. */
  setCreatedAt(id: string, createdAt: Date): void {
    const record = this.byId.get(id);
    if (record) record.createdAt = createdAt;
  }
}

/**
 * PRSprint 09: default-permissive fake — an unregistered `agreementId` resolves to `null` (no
 * agreement found), which `PaymentService.reserveAttempt` treats as "nothing to cross-check", not
 * "reject". Matches this test suite's long-established convention (predating this PRSprint) of
 * using `agreementId` as an opaque grouping label in many fixtures with no backing agreement row —
 * every pre-PRSprint-09 test that never calls `.register()` is unaffected. Tests that specifically
 * exercise the new payer/recipient-vs-agreement cross-check call `.register()` first.
 */
export class InMemoryAgreementPartiesReader implements AgreementPartiesReader {
  private parties = new Map<string, { creditor: ProfileRef; debtor: ProfileRef }>();

  register(agreementId: string, parties: { creditor: ProfileRef; debtor: ProfileRef }): void {
    this.parties.set(agreementId, parties);
  }

  async getParties(agreementId: string): Promise<{ creditor: ProfileRef; debtor: ProfileRef } | null> {
    return this.parties.get(agreementId) ?? null;
  }
}

class InMemoryAuditEventRepositoryForPayments implements AuditEventRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;

  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events.at(-1) ?? null;
  }

  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const stored: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
}

const TEST_WEBHOOK_SECRET = "test-sandbox-payment-webhook-secret";

/**
 * Builds a full PaymentService test context sharing the same underlying VerificationService/
 * profileOwners instances, exactly as production does. PRSprint 18: `balances`/`ledger`/`completion`/
 * `installmentHook` are optional — every pre-PRSprint-18 call site omitting them is unaffected (the
 * overpayment check and completion/manual-payment features simply don't run); pass them (e.g. from
 * `createFullLedgerTestContext`) to exercise those PRSprint 18 behaviors.
 */
export function createTestPaymentService(options?: {
  balances?: AgreementBalanceReader;
  ledger?: LedgerPoster;
  completion?: AgreementCompletionChecker;
  installmentHook?: ManualPaymentInstallmentHook;
  /** PRSprint 20: optional — see AtomicManualPaymentPoster's own doc comment. */
  atomicManualPayments?: AtomicManualPaymentPoster;
  /** Restore agreement payment functionality: optional, so every pre-existing call site is unaffected — see PaymentService's own doc comment on this dependency. */
  notifications?: NotificationService;
}) {
  const verificationCtx = createTestVerificationService();
  const provider = new SandboxPaymentProvider(TEST_WEBHOOK_SECRET);
  const payments = new InMemoryPaymentAttemptRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForPayments();
  const agreements = new InMemoryAgreementPartiesReader();

  const paymentService = new PaymentService({
    provider,
    verification: verificationCtx.verificationService,
    profileOwners: verificationCtx.profileOwners,
    payments,
    audit: new AuditService(auditRepo),
    agreements,
    balances: options?.balances,
    ledger: options?.ledger,
    completion: options?.completion,
    installmentHook: options?.installmentHook,
    atomicManualPayments: options?.atomicManualPayments,
    notifications: options?.notifications,
  });

  return { verificationCtx, provider, payments, auditRepo, agreements, paymentService };
}

/**
 * R06 corrective pass: mirrors `DrizzlePaymentWebhookEventRepository`'s exact claim/lease contract —
 * see that class's, and `PaymentWebhookEventRepository`'s, own doc comments. Every method here is
 * synchronous internally (no `await` between reading and mutating its `Map`/`Set`), the same
 * no-real-race-window property the real DB's transaction/unique-constraint guarantees give the
 * Drizzle implementation — mirrors `InMemoryPaymentAttemptRepository.insertPending`'s identical
 * synchronous-reservation precedent.
 */
export class InMemoryPaymentWebhookEventRepository implements PaymentWebhookEventRepository {
  private byId = new Map<string, PaymentWebhookEventRecord>();
  private reservedKeys = new Set<string>();

  async findByProviderEvent(provider: string, providerEventId: string): Promise<PaymentWebhookEventRecord | null> {
    return [...this.byId.values()].find((e) => e.provider === provider && e.providerEventId === providerEventId) ?? null;
  }

  async tryInsertAndClaim(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    source: PaymentWebhookEventRecord["source"];
    signatureVerified: boolean;
    payload: unknown;
    leaseMs: number;
    now: Date;
  }): Promise<PaymentWebhookEventRecord | null> {
    const key = `${input.provider}:${input.providerEventId}`;
    if (this.reservedKeys.has(key)) return null;
    this.reservedKeys.add(key);
    const record: PaymentWebhookEventRecord = {
      id: randomUUID(),
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      source: input.source,
      signatureVerified: input.signatureVerified,
      payload: input.payload,
      receivedAt: input.now,
      processedAt: null,
      processingStatus: "processing",
      processingAttempts: 1,
      processingStartedAt: input.now,
      lastFailedAt: null,
      lastErrorCode: null,
      nextRetryAt: null,
      leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
      claimToken: randomUUID(),
      providerPaymentId: extractProviderPaymentId(input.payload),
      transitionAppliedAt: null,
      transitionFromStatus: null,
      transitionToStatus: null,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async claimExistingForProcessing(provider: string, providerEventId: string, leaseMs: number, now: Date): Promise<ClaimOutcome> {
    const record = [...this.byId.values()].find((e) => e.provider === provider && e.providerEventId === providerEventId);
    if (!record) return { outcome: "duplicate" };
    if (record.processingStatus === "processed") return { outcome: "duplicate" };
    if (record.processingStatus === "processing") {
      if (record.leaseExpiresAt && record.leaseExpiresAt.getTime() > now.getTime()) return { outcome: "in_progress" };
    } else if (record.processingStatus === "failed") {
      if (!record.nextRetryAt) return { outcome: "not_due" };
      if (record.nextRetryAt.getTime() > now.getTime()) return { outcome: "not_due" };
    }
    record.processingStatus = "processing";
    record.processingAttempts += 1;
    record.processingStartedAt = now;
    record.leaseExpiresAt = new Date(now.getTime() + leaseMs);
    record.claimToken = randomUUID();
    return { outcome: "claimed", record };
  }

  async claimBatchForRecovery(limit: number, leaseMs: number, now: Date): Promise<PaymentWebhookEventRecord[]> {
    const eligible = [...this.byId.values()]
      .filter((e) => {
        if (e.processingStatus === "received") return true;
        if (e.processingStatus === "failed") return e.nextRetryAt !== null && e.nextRetryAt.getTime() <= now.getTime();
        if (e.processingStatus === "processing") return e.leaseExpiresAt !== null && e.leaseExpiresAt.getTime() <= now.getTime();
        return false;
      })
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
      .slice(0, limit);
    for (const record of eligible) {
      record.processingStatus = "processing";
      record.processingAttempts += 1;
      record.processingStartedAt = now;
      record.leaseExpiresAt = new Date(now.getTime() + leaseMs);
      record.claimToken = randomUUID();
    }
    return eligible;
  }

  async markProcessed(id: string, claimToken: string, now: Date): Promise<void> {
    const record = this.byId.get(id);
    if (!record || record.claimToken !== claimToken) return;
    record.processedAt = now;
    record.processingStatus = "processed";
    record.leaseExpiresAt = null;
    record.nextRetryAt = null;
  }

  async markFailedRetryable(id: string, claimToken: string, errorCode: string, nextRetryAt: Date, now: Date): Promise<void> {
    const record = this.byId.get(id);
    if (!record || record.claimToken !== claimToken) return;
    record.processingStatus = "failed";
    record.lastErrorCode = errorCode;
    record.lastFailedAt = now;
    record.nextRetryAt = nextRetryAt;
    record.leaseExpiresAt = null;
  }

  async markFailedPermanent(id: string, claimToken: string, errorCode: string, now: Date): Promise<void> {
    const record = this.byId.get(id);
    if (!record || record.claimToken !== claimToken) return;
    record.processingStatus = "failed";
    record.lastErrorCode = errorCode;
    record.lastFailedAt = now;
    record.nextRetryAt = null;
    record.leaseExpiresAt = null;
  }

  async listAll(): Promise<PaymentWebhookEventRecord[]> {
    return [...this.byId.values()];
  }

  /** Mirrors DrizzlePaymentWebhookEventRepository's own Part D trust rule — see that method's own doc comment. */
  /** Mirrors DrizzlePaymentWebhookEventRepository's own EXACT provenance predicate — see that method's own doc comment (R06+R09 architectural review remediation, Item 3). */
  async findTrustedFinancialEventsForPayment(provider: string, providerPaymentId: string, eventType: string): Promise<PaymentWebhookEventRecord[]> {
    return [...this.byId.values()]
      .filter(
        (e) =>
          e.provider === provider &&
          e.providerPaymentId === providerPaymentId &&
          e.eventType === eventType &&
          ((e.source === "webhook" && e.signatureVerified === true) || (e.source === "provider_lookup" && e.signatureVerified === false)) &&
          e.processingStatus === "processed",
      )
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
      .slice(0, 2);
  }

  /** Mirrors DrizzlePaymentWebhookEventRepository's own identical method — see that method's own doc comment (Stage 9 remediation, Root Correction 4). */
  async findCanonicalTransitionEvidence(provider: string, providerPaymentId: string, targetStatus: PaymentAttemptStatus): Promise<PaymentWebhookEventRecord | null> {
    const matches = [...this.byId.values()].filter(
      (e) =>
        e.provider === provider &&
        e.providerPaymentId === providerPaymentId &&
        e.transitionToStatus === targetStatus &&
        e.transitionAppliedAt !== null &&
        ((e.source === "webhook" && e.signatureVerified === true) || (e.source === "provider_lookup" && e.signatureVerified === false)),
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  /** Test-only helper (not part of PaymentWebhookEventRepository) — used only by InMemoryPaymentTransitionCoordinator, mirrors DrizzlePaymentTransitionCoordinator's identical atomic write. */
  recordTransitionIfClaimTokenMatches(
    id: string,
    claimToken: string,
    fromStatus: PaymentAttemptStatus,
    toStatus: PaymentAttemptStatus,
    appliedAt: Date,
  ): void {
    const record = this.byId.get(id);
    if (!record || record.claimToken !== claimToken) return;
    record.transitionAppliedAt = appliedAt;
    record.transitionFromStatus = fromStatus;
    record.transitionToStatus = toStatus;
  }
}

/** R09 corrective pass (Codex blocker 8): mirrors DrizzlePaymentWebhookEventRepository's identical extraction helper. */
function extractProviderPaymentId(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "providerPaymentId" in payload) {
    const value = (payload as Record<string, unknown>).providerPaymentId;
    return typeof value === "string" ? value : null;
  }
  return null;
}

/**
 * PACKAGE B — remaining Codex blockers: mirrors DrizzlePaymentTransitionCoordinator's exact contract
 * (see that class's own doc comment) — synchronous internally (no `await` between reading and
 * mutating the underlying `Map`s), the same no-real-race-window property the real DB's transaction
 * gives the Drizzle implementation.
 */
export class InMemoryPaymentTransitionCoordinator implements PaymentTransitionCoordinator {
  constructor(
    private readonly payments: InMemoryPaymentAttemptRepository,
    private readonly events: InMemoryPaymentWebhookEventRepository,
  ) {}

  async applyTransition(input: {
    paymentAttemptId: string;
    webhookEventId: string;
    claimToken: string;
    newStatus: PaymentAttemptStatus;
    fields: { providerPaymentId?: string; failureReason?: string };
    allowedSourceStatuses: readonly PaymentAttemptStatus[];
  }): Promise<TransitionApplyResult> {
    const current = await this.payments.findById(input.paymentAttemptId);
    if (!current) throw new Error("payment_attempt not found during transition coordination");
    if (!input.allowedSourceStatuses.includes(current.status)) {
      return { outcome: "rejected", payment: current };
    }
    const updated = await this.payments.updateStatusIfLegalTransition(
      input.paymentAttemptId,
      input.newStatus,
      input.fields,
      input.allowedSourceStatuses,
    );
    if (!updated) return { outcome: "rejected", payment: current };
    this.events.recordTransitionIfClaimTokenMatches(input.webhookEventId, input.claimToken, current.status, input.newStatus, new Date());
    return { outcome: "applied", payment: updated, fromStatus: current.status };
  }
}

/**
 * Builds a full PaymentWebhookService test context sharing the same provider/payments repo as an
 * existing PaymentService context (pass one in to correlate webhook events with payments already
 * created through it). Sprint 10: also wires a LedgerService test context — pass one in (e.g. to
 * inspect posted entries afterward) or a fresh one is created.
 */
export function createTestPaymentWebhookService(
  paymentCtx: ReturnType<typeof createTestPaymentService>,
  ledgerCtx: ReturnType<typeof createTestLedgerService> = createTestLedgerService(),
  /** Sprint 13: optional, so every Sprint 9–12 call site passing only 2 args is unaffected. */
  failedPaymentWorkflow?: FailedPaymentWorkflow,
  /** Sprint 17 review-pass addition: optional, so every pre-Sprint-17 call site is unaffected. */
  notifications?: NotificationService,
  profileOwners?: ProfileOwnerReader,
  /** PRSprint 18: optional, so every pre-PRSprint-18 call site is unaffected. */
  completion?: AgreementCompletionChecker,
) {
  const events = new InMemoryPaymentWebhookEventRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForPayments();
  // SPRINT_19_FraudRisk_SecurityHardening: always wired here (unlike the caller-supplied optional
  // params above) so any test can inspect `riskCtx.riskEvents.events` — the signal itself still only
  // fires when `profileOwners` is also provided (recordFailureRiskSignal's own gate).
  const riskCtx = createTestRiskEventService();
  const transitionCoordinator = new InMemoryPaymentTransitionCoordinator(paymentCtx.payments as InMemoryPaymentAttemptRepository, events);
  const paymentWebhookService = new PaymentWebhookService({
    provider: paymentCtx.provider,
    events,
    payments: paymentCtx.payments,
    transitionCoordinator,
    ledger: ledgerCtx.ledgerService,
    audit: new AuditService(auditRepo),
    failedPaymentWorkflow,
    notifications,
    profileOwners,
    completion,
    riskEvents: riskCtx.riskEventService,
  });
  return { events, auditRepo, ledgerCtx, riskCtx, paymentWebhookService };
}
