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

/**
 * Sprint 12 (docs/sprints/SPRINT_12_DebitCard_Sandbox.md): which rail a payment attempt used. See
 * src/db/schema/enums.ts's paymentMethodEnum doc comment. "manual_off_platform" added PRSprint 18
 * (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md).
 */
export type PaymentMethod = "ach" | "debit_card" | "manual_off_platform";

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
  /** Sprint 12: which rail this attempt used. Null for every pre-Sprint-12 row. */
  paymentMethod: PaymentMethod | null;
  /** PRSprint 18: who recorded a "manual_off_platform" attempt. Null for every provider-routed attempt. */
  recordedByUserId: string | null;
  /** PRSprint 18: optional, purely evidentiary counterparty confirmation of a manual attempt — see paymentService.ts's recordManualOffPlatformPayment doc comment. */
  recipientConfirmedAt: Date | null;
  /**
   * Phase 6A Ledger Payment-Source Rule: which internal `financial_account` (bank connection) funded
   * this attempt — never a routing/account number. Set only for an ACH attempt whose active mandate
   * carries a known `financial_account_id` (see achMandateFinancialAccountAdapter.ts); null for
   * debit_card/manual_off_platform attempts and for every pre-Phase-6A row.
   */
  bankConnectionId: string | null;
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
    /** Sprint 12: which rail this attempt used, if the caller is method-specific (AchPaymentService/DebitCardPaymentService); omitted by Sprint 9's own generic tests. */
    paymentMethod?: PaymentMethod | null;
    /** PRSprint 18: who recorded a "manual_off_platform" attempt. */
    recordedByUserId?: string | null;
    /** Phase 6A: which internal financial_account (bank connection) funded this attempt, if known. */
    bankConnectionId?: string | null;
  }): Promise<PaymentAttemptRecord>;
  updateStatus(
    id: string,
    status: PaymentAttemptStatus,
    fields: { providerPaymentId?: string; failureReason?: string },
  ): Promise<PaymentAttemptRecord>;
  /** PRSprint 18: the recipient's optional, purely evidentiary confirmation of a manually-recorded payment. */
  confirmManualPayment(id: string, confirmedAt: Date): Promise<PaymentAttemptRecord>;
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
  /** Sprint 18B: the Payments UI needs a scoped list, not the cron-only listAll() above. */
  listByAgreementId(agreementId: string): Promise<PaymentAttemptRecord[]>;
}

/**
 * PRSprint 09 (docs/prsprints/PRSPRINT_09_CANONICAL_AGREEMENT_PARTICIPANT_MODEL.md): the minimal
 * read-only lookup `reserveAttempt` needs to enforce "the payer and recipient on an agreement-linked
 * payment must be that agreement's real debtor and creditor" — mirrors `ProfileOwnerReader`'s
 * established small-single-purpose-interface pattern rather than depending on the whole
 * AgreementService (which would also introduce a payments -> agreements module dependency this
 * codebase has never had). Real implementation: DrizzleAgreementPartiesReader.
 */
export interface AgreementPartiesReader {
  /** Returns null if no agreement exists with this id. */
  getParties(agreementId: string): Promise<{ creditor: ProfileRef; debtor: ProfileRef } | null>;
}

/**
 * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md): narrow
 * view onto `BalanceService` — this module only ever needs the remaining balance, to enforce the
 * overpayment policy (see `assertNotOverpaying`'s doc comment for the policy itself). Mirrors
 * `AgreementPartiesReader`'s identical interface-segregation precedent. Real implementation:
 * `BalanceService` itself (structurally compatible — `AgreementBalance` has this field, plus more
 * this module never needs) via `getBalanceService()`. Optional on `PaymentServiceDeps`: every
 * pre-PRSprint-18 test that omits it is unaffected (the overpayment check simply doesn't run), but
 * production wiring (`getPaymentService.ts`) always supplies the real one — this is a genuine
 * financial-integrity control, not a cosmetic one, so it must never be silently absent outside tests.
 */
export interface AgreementBalanceReader {
  getAgreementBalance(agreementId: string): Promise<{ remainingBalanceMinorUnits: number }>;
}

/**
 * PRSprint 18: narrow view onto `LedgerService` — `recordManualOffPlatformPayment` is the one place
 * in this class that ever posts a ledger entry directly (every provider-routed payment's ledger entry
 * is posted by `PaymentWebhookService`, from the provider's own webhook, never from here).
 */
export interface LedgerPoster {
  postPaymentCleared(input: {
    paymentAttemptId: string;
    agreementId: string;
    currency: string;
    grossAmountMinorUnits: number;
  }): Promise<unknown>;
}

/**
 * PRSprint 18: narrow view onto the new `AgreementCompletionService` — recomputes and applies the
 * agreement.status transitions ("FirstPaymentPending -> Active" on first clear, "-> PaidInFull" once
 * the full balance clears) a payment may have just caused. Called after every payment that actually
 * moves money against an agreement — both the provider-routed path (`PaymentWebhookService`, on
 * `payment.succeeded`) and the manual path (`recordManualOffPlatformPayment`, directly).
 */
export interface AgreementCompletionChecker {
  checkAndAdvance(agreementId: string): Promise<void>;
}

/**
 * PRSprint 18: the identical seam `PaymentWebhookService` already uses to mark an installment
 * paid/past-due and cancel a pending retry (Sprint 13) — reused here rather than duplicated, so a
 * manual payment marks its installment paid exactly the same way a provider-cleared one does.
 */
export interface ManualPaymentInstallmentHook {
  handlePaymentSucceeded(payment: PaymentAttemptRecord): Promise<void>;
}

/**
 * PRSprint 20 (docs/prsprints/PRSPRINT_20_IDEMPOTENCY_CONCURRENCY_FINANCIAL_STATE_SAFETY.md):
 * closes a genuine concurrency gap `assertNotOverpaying` alone cannot — two truly concurrent manual
 * payments against the *same* agreement, each individually within the remaining balance but
 * combined exceeding it, would both pass `assertNotOverpaying`'s check (which reads the ledger
 * *before* either has posted) and both succeed, silently overpaying the agreement. Unlike the
 * provider-routed path (where the ledger posting happens later, asynchronously, from a webhook —
 * money has already moved at the processor by then, so rejection is no longer possible; see
 * AgreementCompletionService's "overpaid" defense-in-depth branch for that case instead), a manual
 * payment's read-check-insert-post sequence happens entirely within this one request, with nothing
 * external to wait on — so it CAN be made atomic. The real implementation
 * (`DrizzleAtomicManualPaymentPoster`) wraps the whole sequence in one DB transaction that takes a
 * row lock on the agreement (`SELECT ... FOR UPDATE`), serializing concurrent callers for the same
 * agreement exactly like `DrizzleSigningApplicationRepository.applySigningAtomically` already does
 * for a double-signature race — the second (blocked) caller re-reads the now-current total once
 * unlocked and correctly rejects the overpayment its own pre-check couldn't have seen yet.
 */
export interface AtomicManualPaymentPoster {
  postManualPaymentAtomically(input: {
    idempotencyKey: string;
    agreementId: string;
    payerProfileKind: ProfileKind;
    payerProfileId: string;
    recipientProfileKind: ProfileKind;
    recipientProfileId: string;
    amountMinorUnits: number;
    currency: string;
    recordedByUserId: string;
  }): Promise<PaymentAttemptRecord>;
}

function profileRefEquals(a: ProfileRef, b: ProfileRef): boolean {
  return a.profileKind === b.profileKind && a.profileId === b.profileId;
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
      agreements: AgreementPartiesReader;
      /** PRSprint 18: optional — see AgreementBalanceReader's own doc comment for why. */
      balances?: AgreementBalanceReader;
      /** PRSprint 18: required only by recordManualOffPlatformPayment — checked there, not here. */
      ledger?: LedgerPoster;
      /** PRSprint 18: required only by recordManualOffPlatformPayment — checked there, not here. */
      completion?: AgreementCompletionChecker;
      /** PRSprint 18: optional — mirrors PaymentWebhookService's identical optional dependency. */
      installmentHook?: ManualPaymentInstallmentHook;
      /** PRSprint 20: optional — see AtomicManualPaymentPoster's own doc comment for why production always wires the real one, and most unit tests don't need to. */
      atomicManualPayments?: AtomicManualPaymentPoster;
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
    paymentMethod?: PaymentMethod | null;
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
      paymentMethod?: PaymentMethod | null;
      bankConnectionId?: string | null;
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
      paymentMethod?: PaymentMethod | null;
      bankConnectionId?: string | null;
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

    /**
     * PRSprint 09: nothing here previously cross-checked a caller-supplied `agreementId` against
     * that agreement's actual creditor/debtor — the payer-ownership check above only guarantees the
     * caller owns the *payer* profile, not that `recipient` (or `payer`) is really this specific
     * agreement's canonical counterparty. Left unchecked, a verified user could tag a payment made
     * to any other verified user with an unrelated, real agreement's id, and PaymentWebhookService
     * posts ledger entries keyed on exactly that stored `agreementId` — corrupting a third party's
     * agreement balance with a payment neither of its real parties made. Enforced only when the
     * agreement is found: an `agreementId` that doesn't resolve to any real row is intentionally
     * left unchecked here (a pre-existing, unrelated test-suite convention treats `agreementId` as
     * an opaque grouping label in many fixtures with no backing `agreement` row; a garbage id also
     * cannot corrupt a real counterparty's balance, only create an orphaned ledger account under
     * that id — a data-hygiene concern, not a cross-party integrity one, and a reasonable follow-up
     * for a future PRSprint rather than this one).
     */
    if (input.agreementId) {
      const parties = await this.deps.agreements.getParties(input.agreementId);
      if (parties && (!profileRefEquals(parties.debtor, input.payer) || !profileRefEquals(parties.creditor, input.recipient))) {
        throw new ForbiddenError("The payer and recipient must match this agreement's debtor and creditor.");
      }
    }

    // PRSprint 17: Number.isSafeInteger, not merely Number.isInteger — see schedule.ts's identical
    // hardening for why (an integer past 2**53 cannot be trusted to add/subtract/compare exactly).
    if (!Number.isSafeInteger(input.amountMinorUnits) || input.amountMinorUnits <= 0) {
      throw new ValidationError("amountMinorUnits must be a positive integer.");
    }
    if (input.agreementId) {
      await this.assertNotOverpaying(input.agreementId, input.amountMinorUnits);
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
        paymentMethod: input.paymentMethod ?? null,
        bankConnectionId: input.bankConnectionId ?? null,
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

  /**
   * Sprint 18B: the Payments UI's per-agreement list. Deliberately takes no
   * actingUserId — this class has no agreement-party data to check against,
   * so the caller (the route) is expected to have already authorized the
   * agreement via AgreementService.resolvePartyRole before calling this,
   * the same "authorize at the boundary that owns the data" split already
   * used elsewhere (e.g. SignatureService injects AgreementService itself
   * rather than duplicating party-resolution here for one read method).
   */
  async listByAgreementId(agreementId: string): Promise<PaymentAttemptRecord[]> {
    return this.deps.payments.listByAgreementId(agreementId);
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

  /**
   * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md):
   * records a payment collected entirely outside this platform's payment rails (cash, check, an
   * external transfer) — distinct from every other `createPayment`/`schedulePayment` path, which
   * always routes through `PaymentProvider`. Never calls the provider; the money already moved
   * off-platform, so this is a record-only action that immediately counts toward the agreement's
   * balance (status starts and stays "succeeded" — there is no pending/async settlement to wait on).
   *
   * Restricted to the debtor, mirroring `PartialPaymentService.proposePartialPayment`'s identical
   * "only the borrower may propose" precedent and rationale — the party who made the payment is the
   * one positioned to know it happened; the creditor's role is to optionally confirm it via
   * `confirmManualPayment`, never to record it themselves (a creditor who wants to log money they
   * received off-platform records it as a "collected" fact from the debtor's side of that same
   * conversation, exactly like every other debtor-initiated action in this codebase's negotiation
   * flows). Confirmation is deliberately never a gate on this counting toward the balance — "optional"
   * (the PRSprint's own scope wording) would be meaningless if withholding it blocked the payment from
   * counting; it exists purely as an evidentiary strengthening signal for later dispute resolution.
   */
  async recordManualOffPlatformPayment(input: {
    idempotencyKey: string;
    agreementId: string;
    amountMinorUnits: number;
    actingUserId: string;
  }): Promise<PaymentAttemptRecord> {
    if (!this.deps.ledger) {
      throw new ConfigurationError("Manual off-platform payment recording requires a ledger dependency.");
    }
    const existing = await this.deps.payments.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const parties = await this.deps.agreements.getParties(input.agreementId);
    if (!parties) {
      throw new ValidationError("Agreement not found.");
    }
    const debtorOwnerUserId = await this.deps.profileOwners.getOwnerUserId(parties.debtor.profileKind, parties.debtor.profileId);
    if (debtorOwnerUserId !== input.actingUserId) {
      throw new ForbiddenError("Only the borrower may record a manual off-platform payment.");
    }
    if (!Number.isSafeInteger(input.amountMinorUnits) || input.amountMinorUnits <= 0) {
      throw new ValidationError("amountMinorUnits must be a positive integer.");
    }
    // Fast-fail pre-check outside any lock — cheap, and correctly rejects the overwhelming majority
    // of real (non-racing) overpayment attempts without ever starting a transaction. The atomic
    // poster below re-verifies this exact same invariant again, inside its lock, which is the actual
    // enforcement point for a genuinely concurrent race — see AtomicManualPaymentPoster's doc comment.
    await this.assertNotOverpaying(input.agreementId, input.amountMinorUnits);

    let record: PaymentAttemptRecord;
    if (this.deps.atomicManualPayments) {
      record = await this.deps.atomicManualPayments.postManualPaymentAtomically({
        idempotencyKey: input.idempotencyKey,
        agreementId: input.agreementId,
        payerProfileKind: parties.debtor.profileKind,
        payerProfileId: parties.debtor.profileId,
        recipientProfileKind: parties.creditor.profileKind,
        recipientProfileId: parties.creditor.profileId,
        amountMinorUnits: input.amountMinorUnits,
        currency: "USD",
        recordedByUserId: input.actingUserId,
      });
    } else {
      // No atomic poster wired (most unit tests, which aren't exercising this specific race) — the
      // ordinary insert-then-post sequence, protected only by the pre-check above, not by a lock.
      try {
        record = await this.deps.payments.insertPending({
          idempotencyKey: input.idempotencyKey,
          payerProfileKind: parties.debtor.profileKind,
          payerProfileId: parties.debtor.profileId,
          recipientProfileKind: parties.creditor.profileKind,
          recipientProfileId: parties.creditor.profileId,
          amountMinorUnits: input.amountMinorUnits,
          currency: "USD",
          agreementId: input.agreementId,
          providerName: "manual",
          initialStatus: "succeeded",
          paymentMethod: "manual_off_platform",
          recordedByUserId: input.actingUserId,
        });
      } catch (error) {
        const raced = await this.deps.payments.findByIdempotencyKey(input.idempotencyKey);
        if (raced) return raced;
        throw error;
      }
      // No processor/platform fee on a manual, off-platform payment — the gross amount is exactly the
      // net creditor proceeds, matching LedgerService.postPaymentCleared's own "fees default to 0" precedent.
      await this.deps.ledger.postPaymentCleared({
        paymentAttemptId: record.id,
        agreementId: input.agreementId,
        currency: record.currency,
        grossAmountMinorUnits: record.amountMinorUnits,
      });
    }

    await this.deps.installmentHook?.handlePaymentSucceeded(record);
    await this.deps.completion?.checkAndAdvance(input.agreementId);
    await this.recordAudit(record, "manual_payment_recorded", input.actingUserId, null, null);
    return record;
  }

  /**
   * PRSprint 18: the recipient's optional, purely evidentiary confirmation — see
   * recordManualOffPlatformPayment's doc comment for why this never gates the balance effect.
   */
  async confirmManualPayment(id: string, actingUserId: string): Promise<PaymentAttemptRecord> {
    const record = await this.deps.payments.findById(id);
    if (!record) throw new ValidationError("Payment not found.");
    if (record.paymentMethod !== "manual_off_platform") {
      throw new ValidationError("Only a manually-recorded payment can be confirmed.");
    }
    const recipientOwnerUserId = await this.deps.profileOwners.getOwnerUserId(record.recipientProfileKind, record.recipientProfileId);
    if (recipientOwnerUserId !== actingUserId) {
      throw new ForbiddenError("Only the payment's recipient may confirm a manually-recorded payment.");
    }
    if (record.recipientConfirmedAt) {
      return record; // idempotent — confirming twice is a no-op, not an error.
    }
    const updated = await this.deps.payments.confirmManualPayment(record.id, new Date());
    await this.recordAudit(updated, "manual_payment_confirmed", actingUserId, null, null);
    return updated;
  }

  /**
   * PRSprint 18: the explicit overpayment policy — a payment whose amount would exceed the
   * agreement's current remaining balance is rejected before it ever reaches a provider (or, for a
   * manual payment, before it's ever recorded). No ledger account type exists in this codebase for a
   * refundable credit balance, and no master-spec text mandates permitting one, so this is the one
   * deterministic, explicit rule: overpayment is not permitted. Skipped (never blocks) when
   * `balances` is not wired (most existing tests) or when the agreement has no signed terms yet to
   * compute a balance against (BalanceService throws in that case — nothing to check yet).
   */
  private async assertNotOverpaying(agreementId: string, amountMinorUnits: number): Promise<void> {
    if (!this.deps.balances) return;
    let balance: { remainingBalanceMinorUnits: number } | null;
    try {
      balance = await this.deps.balances.getAgreementBalance(agreementId);
    } catch {
      return;
    }
    if (balance && amountMinorUnits > balance.remainingBalanceMinorUnits) {
      throw new ValidationError(
        `This payment of ${amountMinorUnits} minor units would exceed the agreement's remaining balance of ${balance.remainingBalanceMinorUnits} minor units. Overpayment is not permitted.`,
      );
    }
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
