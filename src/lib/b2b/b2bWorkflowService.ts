import "server-only";
import type { AgreementService, AgreementWithDetail, CreateDraftInput } from "@/lib/agreements/agreementService";
import type { AuditService } from "@/lib/audit/auditService";
import { ValidationError } from "@/lib/errors";
import type { VerificationService } from "@/lib/profiles/verificationService";

export type AgreementReferenceType = "invoice" | "purchase_order" | "contract";

export interface AgreementReferenceRecord {
  id: string;
  agreementId: string;
  referenceType: AgreementReferenceType;
  referenceNumber: string;
  addedByUserId: string;
  addedAt: Date;
}

/** Real implementation: DrizzleAgreementReferenceRepository. */
export interface AgreementReferenceRepository {
  insert(input: {
    agreementId: string;
    referenceType: AgreementReferenceType;
    referenceNumber: string;
    addedByUserId: string;
  }): Promise<AgreementReferenceRecord>;
  listForAgreement(agreementId: string): Promise<AgreementReferenceRecord[]>;
}

export interface B2BWorkflowServiceDeps {
  agreementService: AgreementService;
  verification: VerificationService;
  references: AgreementReferenceRepository;
  audit: AuditService;
}

export interface CreateB2BDraftInput extends CreateDraftInput {
  references?: { referenceType: AgreementReferenceType; referenceNumber: string }[];
}

/**
 * Sprint 8 (docs/sprints/SPRINT_08_Workflows_CSVImports.md) B2B workflow completion. Does not
 * duplicate or weaken Sprint 5's `AgreementService.createDraft` — it gates in front of it ("Both
 * parties must use verified business profiles") and delegates the actual draft creation unchanged.
 * "Authorized signers, titles, signing authority" are already captured per-signature by Sprint 6's
 * `signature_event` table; this class does not re-implement that.
 */
export class B2BWorkflowService {
  constructor(private readonly deps: B2BWorkflowServiceDeps) {}

  async createB2BDraft(input: CreateB2BDraftInput): Promise<AgreementWithDetail> {
    if (input.creditor.kind !== "business" || input.debtor.kind !== "business") {
      throw new ValidationError("Both parties must use verified business profiles for a B2B agreement.");
    }
    const [creditorVerified, debtorVerified] = await Promise.all([
      this.deps.verification.isFullyVerified("business", input.creditor.id),
      this.deps.verification.isFullyVerified("business", input.debtor.id),
    ]);
    if (!creditorVerified) {
      throw new ValidationError("The creditor business must complete verification before creating a B2B agreement.");
    }
    if (!debtorVerified) {
      throw new ValidationError("The debtor business must complete verification before creating a B2B agreement.");
    }

    const result = await this.deps.agreementService.createDraft(input);

    if (input.references?.length) {
      for (const reference of input.references) {
        await this.deps.references.insert({
          agreementId: result.agreement.id,
          referenceType: reference.referenceType,
          referenceNumber: reference.referenceNumber,
          addedByUserId: input.creatorUserId,
        });
      }
    }

    await this.recordAudit(input.creatorUserId, result.agreement.id, "b2b_draft_created", {
      referenceCount: input.references?.length ?? 0,
    });
    return result;
  }

  async addReference(input: {
    agreementId: string;
    actingUserId: string;
    referenceType: AgreementReferenceType;
    referenceNumber: string;
  }): Promise<AgreementReferenceRecord> {
    // Party-only — reuses AgreementService's own authorization primitive, never re-implemented.
    await this.deps.agreementService.resolvePartyRole(input.agreementId, input.actingUserId);
    const record = await this.deps.references.insert({
      agreementId: input.agreementId,
      referenceType: input.referenceType,
      referenceNumber: input.referenceNumber,
      addedByUserId: input.actingUserId,
    });
    await this.recordAudit(input.actingUserId, input.agreementId, "b2b_reference_added", {
      referenceType: input.referenceType,
    });
    return record;
  }

  async listReferences(agreementId: string, actingUserId: string): Promise<AgreementReferenceRecord[]> {
    await this.deps.agreementService.resolvePartyRole(agreementId, actingUserId);
    return this.deps.references.listForAgreement(agreementId);
  }

  private async recordAudit(actorUserId: string, agreementId: string, action: string, newValue: unknown): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "agreement_party",
      profileKind: null,
      profileId: null,
      agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }
}
