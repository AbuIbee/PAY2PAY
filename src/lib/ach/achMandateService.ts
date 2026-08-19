import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { ProfileRef } from "@/lib/payments/paymentProvider";

export type AchMandateStatus = "active" | "revoked" | "expired";

export interface AchMandateRecord {
  id: string;
  agreementId: string;
  payerProfileKind: ProfileKind;
  payerProfileId: string;
  bankAccountRef: string;
  /**
   * Phase 6A: additive read-only exposure of the Sprint 18A `ach_mandate.financial_account_id`
   * column — set only via `AchMandateFinancialAccountAdapter`'s narrow direct-SQL update immediately
   * after `authorize()`, never by this service itself (see this file's own doc comment: "Sprint 11
   * has no concept of financial_account_id"). Read by `AchPaymentService` to populate
   * `payment_attempt.bank_connection_id` (the Ledger Payment-Source Rule) — null for a mandate
   * authorized outside the relationship flow.
   */
  financialAccountId: string | null;
  status: AchMandateStatus;
  authorizedAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  supersedesMandateId: string | null;
  createdAt: Date;
}

/** Sprint 11 (docs/sprints/SPRINT_11_ACH_Sandbox.md): mandates are append-only — `insert` creates a new row, `markRevoked` only ever sets the revocation fields on an existing row, never deletes or overwrites its bank reference. */
export interface AchMandateRepository {
  insert(input: {
    agreementId: string;
    payerProfileKind: ProfileKind;
    payerProfileId: string;
    bankAccountRef: string;
    supersedesMandateId: string | null;
  }): Promise<AchMandateRecord>;
  findActiveForAgreement(agreementId: string): Promise<AchMandateRecord | null>;
  findById(id: string): Promise<AchMandateRecord | null>;
  markRevoked(id: string, revokedAt: Date, revokedReason: string): Promise<AchMandateRecord>;
}

/**
 * Sprint 11's borrower mandate/authorization lifecycle. Deliberately has no dependency on
 * `LedgerService`, `BalanceService`, or `AgreementService` — this class is structurally incapable
 * of touching ledger postings, balances, or agreement terms/status, which is the concrete
 * mechanism behind this sprint's "revoking authorization stops future automatic debits but does
 * not erase debt": revocation can only ever write to `ach_mandate`, never to anything that
 * represents the debt itself. Enforcement that a revoked mandate blocks *new* debits lives in
 * `AchPaymentService` (which reads mandate state before scheduling/submitting), not here.
 */
export class AchMandateService {
  constructor(
    private readonly deps: {
      mandates: AchMandateRepository;
      profileOwners: ProfileOwnerReader;
      audit: AuditService;
    },
  ) {}

  async authorize(input: {
    agreementId: string;
    payer: ProfileRef;
    bankAccountRef: string;
    actingUserId: string;
  }): Promise<AchMandateRecord> {
    await this.requireOwner(input.payer, input.actingUserId, "authorize a mandate");
    const existing = await this.deps.mandates.findActiveForAgreement(input.agreementId);
    if (existing) {
      throw new ConflictError("An active mandate already exists for this agreement.");
    }
    const record = await this.deps.mandates.insert({
      agreementId: input.agreementId,
      payerProfileKind: input.payer.profileKind,
      payerProfileId: input.payer.profileId,
      bankAccountRef: input.bankAccountRef,
      supersedesMandateId: null,
    });
    await this.recordAudit(record, "ach_mandate_authorized", input.actingUserId, null);
    return record;
  }

  async revoke(input: { mandateId: string; actingUserId: string; reason: string }): Promise<AchMandateRecord> {
    const mandate = await this.deps.mandates.findById(input.mandateId);
    if (!mandate) throw new ValidationError("Mandate not found.");
    if (mandate.status !== "active") {
      throw new ValidationError("Only an active mandate can be revoked.");
    }
    await this.requireOwner(
      { profileKind: mandate.payerProfileKind, profileId: mandate.payerProfileId },
      input.actingUserId,
      "revoke this mandate",
    );
    const updated = await this.deps.mandates.markRevoked(mandate.id, new Date(), input.reason);
    await this.recordAudit(updated, "ach_mandate_revoked", input.actingUserId, input.reason);
    return updated;
  }

  /**
   * Bank-change hook: revokes the current active mandate (if any) and authorizes a new one for the
   * new bank account, linked back via `supersedesMandateId` — never mutates the old mandate's bank
   * reference in place, preserving the full authorization history.
   */
  async handleBankChange(input: {
    agreementId: string;
    payer: ProfileRef;
    newBankAccountRef: string;
    actingUserId: string;
  }): Promise<AchMandateRecord> {
    await this.requireOwner(input.payer, input.actingUserId, "change this mandate's bank account");
    const existing = await this.deps.mandates.findActiveForAgreement(input.agreementId);
    if (existing) {
      await this.deps.mandates.markRevoked(existing.id, new Date(), "Bank account changed.");
      await this.recordAudit(existing, "ach_mandate_superseded", input.actingUserId, "Bank account changed.");
    }
    const record = await this.deps.mandates.insert({
      agreementId: input.agreementId,
      payerProfileKind: input.payer.profileKind,
      payerProfileId: input.payer.profileId,
      bankAccountRef: input.newBankAccountRef,
      supersedesMandateId: existing?.id ?? null,
    });
    await this.recordAudit(record, "ach_mandate_authorized", input.actingUserId, "Re-authorized after bank change.");
    return record;
  }

  async getActiveMandate(agreementId: string): Promise<AchMandateRecord | null> {
    return this.deps.mandates.findActiveForAgreement(agreementId);
  }

  async isActiveForAgreement(agreementId: string): Promise<boolean> {
    return (await this.deps.mandates.findActiveForAgreement(agreementId)) !== null;
  }

  private async requireOwner(profile: ProfileRef, actingUserId: string, action: string): Promise<void> {
    const ownerUserId = await this.deps.profileOwners.getOwnerUserId(profile.profileKind, profile.profileId);
    if (ownerUserId !== actingUserId) {
      throw new ForbiddenError(`You may only ${action} for your own profile.`);
    }
  }

  private async recordAudit(mandate: AchMandateRecord, action: string, actorUserId: string, reason: string | null): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "personal_user",
      profileKind: mandate.payerProfileKind,
      profileId: mandate.payerProfileId,
      agreementId: mandate.agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: mandate.status,
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "ach_mandate",
      targetResourceId: mandate.id,
    });
  }
}
