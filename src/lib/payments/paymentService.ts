import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ConfigurationError, ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { VerificationService } from "@/lib/profiles/verificationService";
import type { PaymentProvider, ProfileRef } from "./paymentProvider";

export type PaymentAttemptStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "canceled"
  | "refunded"
  | "disputed"
  /** Reserved for card/network chargebacks (Sprint 12) — not an ACH concept; see enums.ts's doc comment. */
  | "reversed"
  /** Sprint 11: the granular pre-clearing ACH lifecycle (docs/PAYMENT_STATE_MACHINE.md §1). */
  | "scheduled"
  | "submitted"
  | "processing"
  /** Sprint 11: a late ACH return — the correctly-named counterpart to "reversed" above. */
  | "returned";

export interface PaymentAttemptRecord {
  id: string;
  idempotencyKey: string;
  payerProfileKind: ProfileKind;
  payerProfileId: string;
  recipientProfileKind: ProfileKind;
  recipientProfileId: string;
  amountMinorUnits: number;
  currency: string;
  agreementId: string | null;
  status: PaymentAttemptStatus;
  providerName: string;
  providerPaymentId: string | null;
  failureReason: string | null;
  /** Sprint 10: set once, when the ledger's "payout" entry posts — see markPayoutCompleted. */
  payoutCompletedAt: Date | null;
  /** Sprint 11: set once payout is initiated, before it settles — see markPayoutInitiated. */
  payoutInitiatedAt: Date | null;
  /** Sprint 11: which installment (Sprint 5) this attempt collects, if any. */
  installmentScheduleItemId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Sprint 9's durable store for payment attempts. Deliberately minimal — no `payment_method_id` or
 * installment linkage (see src/db/schema/payment.ts's doc comment); Sprint 10+ owns the full ledger.
 * `insertPending` is expected to enforce `idempotencyKey` uniqueness at the storage layer (a DB
 * unique constraint for the Drizzle implementation); PaymentService treats any error from it as a
 * possible concurrent duplicate and re-checks `findByIdempotencyKey` before giving up.
 */
export interface PaymentAttemptRepository {
  insertPending(input: {
    idempotencyKey: string;
    payerProfileKind: ProfileKind;
    payerProfileId: string;
    recipientProfileKind: ProfileKind;
    recipientProfileId: string;
    amountMinorUnits: number;
    currency: string;
    agreementId: string | null;
    providerName: string;
    /** Sprint 11: which installment this attempt collects, if any. */
    installmentScheduleItemId?: string | null;
    /** Sprint 11: the initial status a caller wants — defaults to "pending" (Sprint 9 behavior) if omitted; AchPaymentService passes "scheduled". */
    initialStatus?: PaymentAttemptStatus;
  }): Promise<PaymentAttemptRecord>;
  updateStatus(
    id: string,
    status: PaymentAttemptStatus,
    fields: { providerPaymentId?: string; failureReason?: string },
  ): Promise<PaymentAttemptRecord>;
  findById(id: string): Promise<PaymentAttemptRecord | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<PaymentAttemptRecord | null>;
  findByProviderPaymentId(providerPaymentId: string): Promise<PaymentAttemptRecord | null>;
  /** Sprint 10: recorded once, when LedgerService.postPayout succeeds — never any other way. */
  markPayoutCompleted(id: string, payoutCompletedAt: Date): Promise<PaymentAttemptRecord>;
  /** Sprint 11: recorded once payout is initiated, before it settles. */
  markPayoutInitiated(id: string, payoutInitiatedAt: Date): Promise<PaymentAttemptRecord>;
  /**
   * Sprint 11: duplicate-debit prevention — is there already an unresolved (pending/scheduled/
   * submitted/processing) attempt for this installment? Only unresolved attempts count: a prior
   * attempt that already reached a terminal state (succeeded, failed, canceled, ...) does not block
   * a new one — docs/PAYMENT_STATE_MACHINE.md's "a failed attempt is never mutated into a retry — a
   * new row is created."
   */
  findOpenByInstallment(installmentScheduleItemId: string): Promise<PaymentAttemptRecord | null>;
  /** Sprint 10: batch reconciliation's full-scan entry point (ReconciliationService.reconcileAll) — a periodic/administrative operation, not a per-request hot path. */
  listAll(): Promise<PaymentAttemptRecord[]>;
}

/**
 * Sprint 9 (docs/sprints/SPRINT_09_PaymentProviderAbstraction _Sandbox.md): the shared abstraction
 * application code depends on instead of any specific processor. This is the ONE place that calls
 * Sprint 3's `isFullyVerified` for both payer and recipient before creating a payment, per this
 * sprint's explicit instruction — individual provider adapters and the Sprint 10 ledger must not be
 * able to bypass this by calling a `PaymentProvider` directly; they only ever get a payment created
 * through this class.
 */
export class PaymentService {
  constructor(
    private readonly deps: {
      provider: PaymentProvider;
      verification: VerificationService;
      profileOwners: ProfileOwnerReader;
      payments: PaymentAttemptRepository;
      audit: AuditService;
    },
  ) {}

  async createPayment(input: {
    idempotencyKey: string;
    payer: ProfileRef;
    recipient: ProfileRef;
    amountMinorUnits: number;
    currency: string;
    agreementId?: string | null;
    actingUserId: string;
    ipAddress: string | null;
    deviceInfo: unknown;
  }): Promise<PaymentAttemptRecord> {
    const reserved = await this.reserveAttempt(input);
    if (reserved.alreadyResolved) return reserved.record;
    return this.submitToProvider(reserved.record, input);
  }

  /**
   * Sprint 11 (docs/sprints/SPRINT_11_ACH_Sandbox.md): the two-phase counterpart to
   * `createPayment`, for callers (AchPaymentService) that need to record a payment as "scheduled"
   * ahead of the actual submission time, without calling the provider yet. Runs through exactly the
   * same idempotency/ownership/verification gate as `createPayment` — there is still no way to
   * reach the provider (`submitPending`) without having passed through this gate first, preserving
   * this class's "the only place that calls isFullyVerified" guarantee.
   */
  async schedulePayment(
    input: {
      idempotencyKey: string;
      payer: ProfileRef;
      recipient: ProfileRef;
      amountMinorUnits: number;
      currency: string;
      agreementId?: string | null;
      actingUserId: string;
      installmentScheduleItemId?: string | null;
    },
    initialStatus: PaymentAttemptStatus = "scheduled",
  ): Promise<PaymentAttemptRecord> {
    const reserved = await this.reserveAttempt(input, initialStatus);
    return reserved.record;
  }

  /**
   * Sprint 11: performs the provider call for a payment previously created via `schedulePayment`
   * (status "scheduled"). Transitions scheduled → submitted → processing (or "failed" if the
   * provider call itself fails) — the same failure-handling shape as `createPayment`'s own
   * provider-call step.
   */
  async submitPending(id: string, actingUserId: string, ipAddress: string | null = null, deviceInfo: unknown = null): Promise<PaymentAttemptRecord> {
    const record = await this.deps.payments.findById(id);
    if (!record) throw new ValidationError("Payment not found.");
    if (record.status !== "scheduled") {
      throw new ValidationError("Only a scheduled payment can be submitted.");
    }
    const submitted = await this.deps.payments.updateStatus(record.id, "submitted", {});
    return this.submitToProvider(submitted, {
      payer: { profileKind: record.payerProfileKind, profileId: record.payerProfileId },
      recipient: { profileKind: record.recipientProfileKind, profileId: record.recipientProfileId },
      actingUserId,
      ipAddress,
      deviceInfo,
    });
  }

  private async reserveAttempt(
    input: {
      idempotencyKey: string;
      payer: ProfileRef;
      recipient: ProfileRef;
      amountMinorUnits: number;
      currency: string;
      agreementId?: string | null;
      actingUserId: string;
      installmentScheduleItemId?: string | null;
    },
    initialStatus?: PaymentAttemptStatus,
  ): Promise<{ record: PaymentAttemptRecord; alreadyResolved: boolean }> {
    const existing = await this.deps.payments.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return { record: existing, alreadyResolved: true };

    const payerOwnerUserId = await this.deps.profileOwners.getOwnerUserId(
      input.payer.profileKind,
      input.payer.profileId,
    );
    if (payerOwnerUserId !== input.actingUserId) {
      throw new ForbiddenError("You may only create a payment as the payer.");
    }

    if (!Number.isInteger(input.amountMinorUnits) || input.amountMinorUnits <= 0) {
      throw new ValidationError("amountMinorUnits must be a positive integer.");
    }

    const [payerVerified, recipientVerified] = await Promise.all([
      this.deps.verification.isFullyVerified(input.payer.profileKind, input.payer.profileId),
      this.deps.verification.isFullyVerified(input.recipient.profileKind, input.recipient.profileId),
    ]);
    if (!payerVerified) {
      throw new ValidationError("The payer must complete identity verification before a payment can be created.");
    }
    if (!recipientVerified) {
      throw new ValidationError("The recipient must complete identity verification before a payment can be created.");
    }

    try {
      const record = await this.deps.payments.insertPending({
        idempotencyKey: input.idempotencyKey,
        payerProfileKind: input.payer.profileKind,
        payerProfileId: input.payer.profileId,
        recipientProfileKind: input.recipient.profileKind,
        recipientProfileId: input.recipient.profileId,
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
        agreementId: input.agreementId ?? null,
        providerName: this.deps.provider.providerName,
        installmentScheduleItemId: input.installmentScheduleItemId ?? null,
        initialStatus,
      });
      return { record, alreadyResolved: false };
    } catch (error) {
      const raced = await this.deps.payments.findByIdempotencyKey(input.idempotencyKey);
      if (raced) return { record: raced, alreadyResolved: true };
      throw error;
    }
  }

  private async submitToProvider(
    record: PaymentAttemptRecord,
    input: { payer: ProfileRef; recipient: ProfileRef; actingUserId: string; ipAddress: string | null; deviceInfo: unknown },
  ): Promise<PaymentAttemptRecord> {
    try {
      const result = await this.deps.provider.createPayment({
        idempotencyKey: record.idempotencyKey,
        amountMinorUnits: record.amountMinorUnits,
        currency: record.currency,
        payer: input.payer,
        recipient: input.recipient,
      });
      const resolvedStatus: PaymentAttemptStatus = result.status === "pending" && record.status === "submitted" ? "processing" : result.status;
      const updated = await this.deps.payments.updateStatus(record.id, resolvedStatus, {
        providerPaymentId: result.providerPaymentId,
      });
      await this.recordAudit(updated, "payment_created", input.actingUserId, input.ipAddress, input.deviceInfo);
      return updated;
    } catch (error) {
      const failed = await this.deps.payments.updateStatus(record.id, "failed", {
        failureReason: error instanceof Error ? error.message : "unknown_processor_error",
      });
      await this.recordAudit(failed, "payment_creation_failed", input.actingUserId, input.ipAddress, input.deviceInfo);
      throw new ValidationError("Payment could not be created with the payment provider.");
    }
  }

  async retrievePayment(id: string, actingUserId: string): Promise<PaymentAttemptRecord> {
    return this.getAuthorizedRecord(id, actingUserId, "payer_or_recipient");
  }

  async cancelPayment(id: string, actingUserId: string): Promise<PaymentAttemptRecord> {
    const record = await this.getAuthorizedRecord(id, actingUserId, "payer_or_recipient");
    if (!["pending", "scheduled"].includes(record.status)) {
      throw new ValidationError("Only a pending or scheduled payment can be canceled.");
    }
    // Sprint 11: a "scheduled" payment was never submitted to the provider (docs/PAYMENT_STATE_MACHINE.md
    // §1: "Scheduled → Canceled: superseded by manual payment before retry fires") — there is
    // nothing for the provider to cancel, so this is a local-only transition.
    if (record.status !== "scheduled") {
      const result = await this.deps.provider.cancelPayment(record.providerPaymentId ?? "");
      if (!result.canceled) {
        throw new ValidationError("The payment provider did not permit cancellation.");
      }
    }
    const updated = await this.deps.payments.updateStatus(record.id, "canceled", {});
    await this.recordAudit(updated, "payment_canceled", actingUserId, null, null);
    return updated;
  }

  async refundPayment(id: string, actingUserId: string): Promise<PaymentAttemptRecord> {
    const record = await this.getAuthorizedRecord(id, actingUserId, "recipient_only");
    if (record.status !== "succeeded") {
      throw new ValidationError("Only a succeeded payment can be refunded.");
    }
    if (!record.providerPaymentId) {
      throw new ConfigurationError("A succeeded payment is missing its provider payment id.");
    }
    await this.deps.provider.refundPayment(record.providerPaymentId);
    const updated = await this.deps.payments.updateStatus(record.id, "refunded", {});
    await this.recordAudit(updated, "payment_refunded", actingUserId, null, null);
    return updated;
  }

  private async getAuthorizedRecord(
    id: string,
    actingUserId: string,
    mode: "payer_or_recipient" | "recipient_only",
  ): Promise<PaymentAttemptRecord> {
    const record = await this.deps.payments.findById(id);
    if (!record) throw new ValidationError("Payment not found.");

    const [payerOwner, recipientOwner] = await Promise.all([
      this.deps.profileOwners.getOwnerUserId(record.payerProfileKind, record.payerProfileId),
      this.deps.profileOwners.getOwnerUserId(record.recipientProfileKind, record.recipientProfileId),
    ]);
    const isPayer = payerOwner === actingUserId;
    const isRecipient = recipientOwner === actingUserId;

    if (mode === "recipient_only" && !isRecipient) {
      throw new ForbiddenError("Only the payment's recipient may perform this action.");
    }
    if (mode === "payer_or_recipient" && !isPayer && !isRecipient) {
      throw new ForbiddenError("You do not have access to this payment.");
    }
    return record;
  }

  private async recordAudit(
    record: PaymentAttemptRecord,
    action: string,
    actorUserId: string | null,
    ipAddress: string | null,
    deviceInfo: unknown,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: actorUserId ? "personal_user" : "payment_provider",
      profileKind: record.payerProfileKind,
      profileId: record.payerProfileId,
      agreementId: record.agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress,
      deviceInfo: deviceInfo ?? null,
      previousValue: null,
      newValue: record.status,
      reason: record.failureReason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payment_attempt",
      targetResourceId: record.id,
    });
  }
}
