import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { isAdminRole } from "@/lib/admin/capabilities";
import type { PlatformRole } from "@/lib/auth/authService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { LedgerService } from "@/lib/ledger/ledgerService";
import type { PaymentAttemptRepository, PaymentMethod } from "@/lib/payments/paymentService";

export type PaymentDisputeStatus = "claimed" | "upheld" | "denied";
export type PaymentDisputeCategory = "unauthorized_ach" | "unauthorized_debit_card" | "processor_dispute";

export interface PaymentDisputeRecord {
  id: string;
  paymentAttemptId: string;
  status: PaymentDisputeStatus;
  category: PaymentDisputeCategory;
  explanation: string;
  claimedByProfileKind: ProfileKind;
  claimedByProfileId: string;
  claimedByUserId: string;
  preservedMandateReference: string | null;
  preservedSignatureReference: string | null;
  preservedIdentityVerificationReference: string | null;
  ipAddress: string | null;
  deviceInfo: unknown;
  claimedAt: Date;
  resolutionNotes: string | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzlePaymentDisputeRepository. */
export interface PaymentDisputeRepository {
  insert(input: {
    paymentAttemptId: string;
    category: PaymentDisputeCategory;
    explanation: string;
    claimedByProfileKind: ProfileKind;
    claimedByProfileId: string;
    claimedByUserId: string;
    preservedMandateReference: string | null;
    preservedSignatureReference: string | null;
    preservedIdentityVerificationReference: string | null;
    ipAddress: string | null;
    deviceInfo: unknown;
  }): Promise<PaymentDisputeRecord>;
  findById(id: string): Promise<PaymentDisputeRecord | null>;
  listForPaymentAttempt(paymentAttemptId: string): Promise<PaymentDisputeRecord[]>;
  recordResolution(
    id: string,
    input: { status: "upheld" | "denied"; resolutionNotes: string | null; resolvedByUserId: string },
  ): Promise<PaymentDisputeRecord>;
}

/** Sprint 16: "preserve mandate" — an opaque reference (ach_mandate/debit_card_method id) captured once, at claim time. Narrow by design (this module needs nothing else from either table). */
export interface MandateReferenceReader {
  findActiveReference(agreementId: string, paymentMethod: PaymentMethod | null): Promise<string | null>;
}

/** Sprint 16: "preserve signatures" — the claiming payer's own `signature_event` id for the agreement's current version. */
export interface SignatureReferenceReader {
  findReference(agreementId: string, payerProfileKind: ProfileKind, payerProfileId: string): Promise<string | null>;
}

/** Sprint 16: "preserve identity verification reference." */
export interface IdentityVerificationReferenceReader {
  findReference(profileKind: ProfileKind, profileId: string): Promise<string | null>;
}

export interface PaymentDisputeServiceDeps {
  payments: PaymentAttemptRepository;
  disputes: PaymentDisputeRepository;
  ledger: LedgerService;
  profileOwners: ProfileOwnerReader;
  mandates: MandateReferenceReader;
  signatures: SignatureReferenceReader;
  identityVerifications: IdentityVerificationReferenceReader;
  audit: AuditService;
}

/**
 * Sprint 16 (docs/sprints/SPRINT_16_Disputes.md): implements master spec §13/FR-UPAY's payment-level
 * unauthorized-payment claim — deliberately separate from `AgreementDisputeService` ("Do not
 * conflate them," this sprint's own instruction, verbatim). See paymentDispute.ts's doc comment for
 * why the four `preserved_*` fields are opaque snapshot strings, not foreign keys.
 *
 * "The processor handles payment dispute outcome" is implemented literally: `claimUnauthorizedPayment`
 * only ever sets `payment_dispute.status = "claimed"` and reuses `LedgerService.reversePayment`'s
 * existing `"dispute_adjustment"` entry type — the exact same call the `payment.disputed` webhook
 * (Sprint 9/10, `PaymentWebhookService`) already makes, so a claim filed through this service and one
 * the processor reports asynchronously produce identical ledger/status effects, never a second,
 * competing transition path. `recordProcessorOutcome` is Platform-Admin-only (never a party
 * self-service action) and only ever *records* what the processor determined — for `"upheld"` it
 * reuses the same `"refund"` ledger entry type the `payment.refunded` webhook already posts; for
 * `"denied"` it reinstates `payment_attempt.status` to `"succeeded"` ("payment stands",
 * `docs/STATE_MACHINES.md` §2's `Disputed --> PaidOut: claim denied`) but does **not** attempt to
 * un-post the earlier `dispute_adjustment` ledger entry — `LedgerJournalEntryRepository` is
 * append-only by design (Sprint 10) with no "un-reverse" entry type, so a denied claim that needs its
 * ledger effect corrected goes through Sprint 10's own existing `LedgerAdminService.postAdjustment`
 * escape hatch instead of this class inventing new ledger mechanics. Documented as a known limitation
 * (see `docs/SPRINT_CONTROL.md`'s Sprint 16 implementation notes) rather than silently assumed —
 * "denied" is expected to be the rare outcome, and `BalanceService`'s existing presence-based
 * `wasReversed` check is unchanged by this sprint.
 */
export class PaymentDisputeService {
  constructor(private readonly deps: PaymentDisputeServiceDeps) {}

  async claimUnauthorizedPayment(input: {
    paymentAttemptId: string;
    category: PaymentDisputeCategory;
    explanation: string;
    actingUserId: string;
    ipAddress: string | null;
    deviceInfo: unknown;
  }): Promise<PaymentDisputeRecord> {
    const payment = await this.deps.payments.findById(input.paymentAttemptId);
    if (!payment) throw new ValidationError("Payment not found.");

    const payerOwnerUserId = await this.deps.profileOwners.getOwnerUserId(payment.payerProfileKind, payment.payerProfileId);
    if (payerOwnerUserId !== input.actingUserId) {
      throw new ForbiddenError("Only the payer may claim a payment as unauthorized.");
    }
    if (payment.status !== "succeeded") {
      throw new ValidationError(`Only a succeeded payment can be disputed as unauthorized, but this payment is "${payment.status}".`);
    }
    if (!input.explanation.trim()) {
      throw new ValidationError("A written explanation is required to claim a payment as unauthorized.");
    }
    if (input.category === "unauthorized_ach" && payment.paymentMethod !== "ach") {
      throw new ValidationError('category "unauthorized_ach" requires an ACH payment.');
    }
    if (input.category === "unauthorized_debit_card" && payment.paymentMethod !== "debit_card") {
      throw new ValidationError('category "unauthorized_debit_card" requires a debit-card payment.');
    }
    if (!payment.agreementId) {
      throw new ValidationError("This payment has no associated agreement to dispute against.");
    }

    const [mandateRef, signatureRef, identityRef] = await Promise.all([
      this.deps.mandates.findActiveReference(payment.agreementId, payment.paymentMethod),
      this.deps.signatures.findReference(payment.agreementId, payment.payerProfileKind, payment.payerProfileId),
      this.deps.identityVerifications.findReference(payment.payerProfileKind, payment.payerProfileId),
    ]);

    const dispute = await this.deps.disputes.insert({
      paymentAttemptId: payment.id,
      category: input.category,
      explanation: input.explanation,
      claimedByProfileKind: payment.payerProfileKind,
      claimedByProfileId: payment.payerProfileId,
      claimedByUserId: input.actingUserId,
      preservedMandateReference: mandateRef,
      preservedSignatureReference: signatureRef,
      preservedIdentityVerificationReference: identityRef,
      ipAddress: input.ipAddress,
      deviceInfo: input.deviceInfo,
    });

    await this.deps.payments.updateStatus(payment.id, "disputed", {});
    await this.deps.ledger.reversePayment({ paymentAttemptId: payment.id, entryType: "dispute_adjustment", reason: input.explanation });

    await this.recordAudit(dispute, input.actingUserId, "payment_dispute_claimed", { category: input.category });
    return dispute;
  }

  /** Platform-Admin-only — records the processor's own determination; never a party self-service action, matching "the platform must not adjudicate legal liability." */
  async recordProcessorOutcome(input: {
    paymentDisputeId: string;
    outcome: "upheld" | "denied";
    actingUserId: string;
    actingRole: PlatformRole;
    resolutionNotes?: string;
  }): Promise<PaymentDisputeRecord> {
    if (!isAdminRole(input.actingRole)) {
      throw new ForbiddenError("Administrative access is required to record a payment dispute outcome.");
    }
    const dispute = await this.requireDispute(input.paymentDisputeId);
    if (dispute.status !== "claimed") {
      throw new ValidationError(`This action requires status "claimed", but the dispute is "${dispute.status}".`);
    }

    if (input.outcome === "upheld") {
      await this.deps.payments.updateStatus(dispute.paymentAttemptId, "refunded", {});
      await this.deps.ledger.reversePayment({
        paymentAttemptId: dispute.paymentAttemptId,
        entryType: "refund",
        reason: input.resolutionNotes ?? "Unauthorized-payment claim upheld",
      });
    } else {
      // "Claim denied, payment stands" — reinstates the payment's own status; see this class's doc
      // comment for why the earlier dispute_adjustment ledger entry is deliberately not un-posted.
      await this.deps.payments.updateStatus(dispute.paymentAttemptId, "succeeded", {});
    }

    const updated = await this.deps.disputes.recordResolution(dispute.id, {
      status: input.outcome,
      resolutionNotes: input.resolutionNotes ?? null,
      resolvedByUserId: input.actingUserId,
    });
    await this.recordAudit(updated, input.actingUserId, `payment_dispute_${input.outcome}`, { resolutionNotes: input.resolutionNotes ?? null }, input.actingRole);
    return updated;
  }

  async getDispute(paymentDisputeId: string, actingUserId: string): Promise<PaymentDisputeRecord> {
    const dispute = await this.requireDispute(paymentDisputeId);
    await this.requirePartyOrAdminAccess(dispute, actingUserId);
    return dispute;
  }

  async listDisputesForPayment(paymentAttemptId: string, actingUserId: string): Promise<PaymentDisputeRecord[]> {
    const payment = await this.deps.payments.findById(paymentAttemptId);
    if (!payment) throw new ValidationError("Payment not found.");
    const payerOwnerUserId = await this.deps.profileOwners.getOwnerUserId(payment.payerProfileKind, payment.payerProfileId);
    const recipientOwnerUserId = await this.deps.profileOwners.getOwnerUserId(payment.recipientProfileKind, payment.recipientProfileId);
    if (actingUserId !== payerOwnerUserId && actingUserId !== recipientOwnerUserId) {
      throw new ForbiddenError("You do not have access to this payment's disputes.");
    }
    return this.deps.disputes.listForPaymentAttempt(paymentAttemptId);
  }

  private async requirePartyOrAdminAccess(dispute: PaymentDisputeRecord, actingUserId: string): Promise<void> {
    const payerOwnerUserId = await this.deps.profileOwners.getOwnerUserId(dispute.claimedByProfileKind, dispute.claimedByProfileId);
    if (actingUserId !== payerOwnerUserId) {
      throw new ForbiddenError("You do not have access to this payment dispute.");
    }
  }

  private async requireDispute(id: string): Promise<PaymentDisputeRecord> {
    const dispute = await this.deps.disputes.findById(id);
    if (!dispute) throw new ValidationError("Payment dispute not found.");
    return dispute;
  }

  private async recordAudit(
    dispute: PaymentDisputeRecord,
    actorUserId: string,
    action: string,
    newValue: unknown,
    actorRole: string = "agreement_party",
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole,
      profileKind: dispute.claimedByProfileKind,
      profileId: dispute.claimedByProfileId,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: dispute.ipAddress,
      deviceInfo: dispute.deviceInfo,
      previousValue: null,
      newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "payment_dispute",
      targetResourceId: dispute.id,
    });
  }
}
