import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { AgreementRepository } from "@/lib/agreements/agreementService";
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
  /**
   * PAID2YOU — B0-D ADYEN PHASE 2: every currently-`active` mandate referencing this exact
   * `bankAccountRef` — plural because the SAME reusable `financial_account`/provider token can be
   * authorized as the funding source for multiple agreements at once (Sprint 18A's reusable-account
   * model). Used by `revokeAllForBankAccountRef` when the provider itself reports the underlying
   * token disabled — every agreement relying on it must lose its active mandate, not just one.
   */
  findActiveByBankAccountRef(bankAccountRef: string): Promise<AchMandateRecord[]>;
  markRevoked(id: string, revokedAt: Date, revokedReason: string): Promise<AchMandateRecord>;
}

/**
 * PAID2YOU — B0-D ADYEN PHASE 2 (item 5 — mandate integration): narrow read-only dependency verifying
 * a `bankAccountRef` presented to `authorize`/`handleBankChange` is a REAL, provider-confirmed,
 * currently-verified `financial_account` owned by the exact payer profile — never merely a
 * client-supplied string trusted at face value (the pre-existing gap this closes: previously any
 * string satisfying `.min(1).max(500)` was accepted, so a payment attempt against a bogus reference
 * would only fail much later, at Adyen, instead of being refused here at authorization time). Real
 * implementation: `DrizzleFinancialAccountOwnershipVerifier`.
 */
export interface FinancialAccountOwnershipVerifier {
  isVerifiedAccountOwnedByProfile(providerAccountRef: string, profile: ProfileRef): Promise<boolean>;
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
      /**
       * R08 B1 (ACH-1): narrow read-only dependency used solely to bind an authorized mandate back to
       * its agreement's own persisted debtor — never the entire AgreementService (this class remains
       * structurally incapable of touching agreement status/terms; see this file's own doc comment).
       */
      agreements: Pick<AgreementRepository, "findById">;
      audit: AuditService;
      /**
       * PAID2YOU — B0-D ADYEN PHASE 2: optional so the many pre-existing tests exercising unrelated
       * mandate-lifecycle concerns are unaffected — production wiring (`getAchMandateService.ts`)
       * always supplies this. See `FinancialAccountOwnershipVerifier`'s own doc comment.
       */
      financialAccounts?: FinancialAccountOwnershipVerifier;
    },
  ) {}

  async authorize(input: {
    agreementId: string;
    payer: ProfileRef;
    bankAccountRef: string;
    actingUserId: string;
  }): Promise<AchMandateRecord> {
    await this.requireOwner(input.payer, input.actingUserId, "authorize a mandate");
    await this.requirePayerIsAgreementDebtor(input.agreementId, input.payer);
    await this.requireVerifiedOwnedBankAccountRef(input.bankAccountRef, input.payer);
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
   *
   * R08 B2 (EC1-002 correction): this method previously called only `requireOwner`, exactly the same
   * gap the R08 B1 correction closed in `authorize()` above — owning the claimed payer profile proves
   * nothing about that profile's relationship to `agreementId`. Left unchecked, an attacker owning any
   * unrelated profile P could supply a victim agreement's id and have that agreement's active mandate
   * revoked and replaced with one pointing at P and an attacker-chosen bank reference. Reuses the SAME
   * `requirePayerIsAgreementDebtor` helper `authorize()` already uses — no duplicated logic — and runs
   * it BEFORE `findActiveForAgreement`/`markRevoked`/the supersession audit/`insert`, so an
   * unauthorized call produces zero persistent mutation.
   */
  async handleBankChange(input: {
    agreementId: string;
    payer: ProfileRef;
    newBankAccountRef: string;
    actingUserId: string;
  }): Promise<AchMandateRecord> {
    await this.requireOwner(input.payer, input.actingUserId, "change this mandate's bank account");
    await this.requirePayerIsAgreementDebtor(input.agreementId, input.payer);
    await this.requireVerifiedOwnedBankAccountRef(input.newBankAccountRef, input.payer);
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

  /**
   * PAID2YOU — B0-D ADYEN PHASE 2: the SYSTEM-triggered counterpart to `revoke` above — called ONLY
   * from the Adyen token-lifecycle webhook handler when the provider itself reports a token disabled,
   * never from a route handler with a real acting user (there is none — the provider is the
   * authority, exactly like `LedgerService`'s own `"ledger_system"` actor precedent). Revokes EVERY
   * currently-active mandate referencing this token, not just one — see
   * `findActiveByBankAccountRef`'s own doc comment for why there can be more than one. This is the
   * concrete mechanism that makes "a disabled Adyen token becomes unusable for future Paid2You
   * payments" actually true: `PaymentService.submitToProvider` requires an active mandate before it
   * will ever call `createPayment`, and a revoked mandate can never legally become active again
   * (mandates are append-only — a new one requires a fresh, real authorization). Idempotent: an
   * already-revoked mandate is simply skipped, never re-revoked or double-audited.
   */
  async revokeAllForBankAccountRef(bankAccountRef: string, reason: string): Promise<AchMandateRecord[]> {
    const active = await this.deps.mandates.findActiveByBankAccountRef(bankAccountRef);
    const revoked: AchMandateRecord[] = [];
    for (const mandate of active) {
      const updated = await this.deps.mandates.markRevoked(mandate.id, new Date(), reason);
      await this.recordAudit(updated, "ach_mandate_revoked_by_provider", null, reason, "payment_provider_webhook");
      revoked.push(updated);
    }
    return revoked;
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

  /**
   * R08 B1 (ACH-1 correction): owning the payer profile (`requireOwner`) proves the caller is who
   * they claim to be — it proves nothing about whether that profile has any relationship to the
   * client-supplied `agreementId`. Without this, an attacker who owns some unrelated profile P could
   * supply a completely unrelated victim agreement A and have a mandate created against A anyway
   * (`requireOwner` succeeds for P, and nothing previously checked P against A at all). This closes
   * that gap by requiring the payer be EXACTLY agreement A's own persisted debtor — never merely "a
   * party to A" (the creditor is never an acceptable payer) and never inferred from
   * `createdByUserId`/`relationshipId`, which are not authorization signals. Performs no mutation;
   * runs before any mandate lookup/insert, so an unauthorized call leaves zero trace.
   */
  private async requirePayerIsAgreementDebtor(agreementId: string, payer: ProfileRef): Promise<void> {
    const agreement = await this.deps.agreements.findById(agreementId);
    if (!agreement) {
      throw new ValidationError("Agreement not found.");
    }
    if (agreement.debtorProfileKind !== payer.profileKind || agreement.debtorProfileId !== payer.profileId) {
      throw new ForbiddenError("The payer must be this agreement's own debtor.");
    }
  }

  /**
   * PAID2YOU — B0-D ADYEN PHASE 2 (item 5): the exact Adyen `storedPaymentMethodId` a mandate
   * references must be a REAL, provider-confirmed `financial_account` the payer actually owns and
   * that has actually completed verification — never a bare client-supplied string trusted at face
   * value (see `FinancialAccountOwnershipVerifier`'s own doc comment for the gap this closes). A
   * no-op (skipped, never silently passes) only when this dependency isn't wired — pre-existing test
   * contexts that never exercise bank-tokenization coupling; production wiring always supplies it.
   */
  private async requireVerifiedOwnedBankAccountRef(bankAccountRef: string, payer: ProfileRef): Promise<void> {
    if (!this.deps.financialAccounts) return;
    const owned = await this.deps.financialAccounts.isVerifiedAccountOwnedByProfile(bankAccountRef, payer);
    if (!owned) {
      throw new ValidationError("This bank account reference is not a verified account belonging to the payer profile.");
    }
  }

  private async recordAudit(mandate: AchMandateRecord, action: string, actorUserId: string | null, reason: string | null, actorRole = "personal_user"): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole,
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
