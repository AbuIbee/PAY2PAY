import "server-only";
import { createHash } from "node:crypto";
import type { AgreementService, PartyRole } from "@/lib/agreements/agreementService";
import type { AuditService } from "@/lib/audit/auditService";
import type { DocumentStorage } from "@/lib/documents/documentStorage";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { FileValidator } from "./fileValidator";

export type EvidenceDocumentType =
  | "invoice"
  | "receipt"
  | "contract"
  | "estimate"
  | "purchase_order"
  | "proof_of_delivery"
  | "proof_of_completed_work"
  | "prior_payment_record"
  | "other";

export type EvidenceVisibility = "shared" | "private";
export type EvidenceWithdrawalState = "active" | "withdrawn";
export type EvidenceFileValidationStatus = "pending" | "clean" | "rejected";

export interface EvidenceRecord {
  id: string;
  agreementId: string;
  uploadedByUserId: string;
  documentType: EvidenceDocumentType;
  description: string | null;
  storagePath: string;
  documentHash: string;
  fileSizeBytes: number;
  contentType: string;
  isPostSigning: boolean;
  visibility: EvidenceVisibility;
  sharedWithWitnesses: boolean;
  disputeFlag: boolean;
  withdrawalState: EvidenceWithdrawalState;
  fileValidationStatus: EvidenceFileValidationStatus;
  uploadedAt: Date;
}

/** Real implementation: DrizzleEvidenceRepository. */
export interface EvidenceRepository {
  insert(
    input: Omit<EvidenceRecord, "id" | "uploadedAt" | "disputeFlag" | "withdrawalState">,
  ): Promise<EvidenceRecord>;
  findById(id: string): Promise<EvidenceRecord | null>;
  listForAgreement(agreementId: string): Promise<EvidenceRecord[]>;
  updateWithdrawalState(id: string, state: EvidenceWithdrawalState): Promise<void>;
  updateDisputeFlag(id: string, flag: boolean): Promise<void>;
}

/** Read-only access to an agreement's current witness roster — provided by WitnessService's repository, kept separate so EvidenceService never gains write access to agreement_witness. */
export interface EvidenceWitnessReader {
  isActiveWitness(agreementId: string, userId: string): Promise<boolean>;
}

export interface EvidenceServiceDeps {
  agreementService: AgreementService;
  evidence: EvidenceRepository;
  witnesses: EvidenceWitnessReader;
  storage: DocumentStorage;
  fileValidator: FileValidator;
  audit: AuditService;
}

export interface UploadEvidenceInput {
  agreementId: string;
  actingUserId: string;
  documentType: EvidenceDocumentType;
  description: string | null;
  fileName: string;
  contentType: string;
  content: Uint8Array;
  visibility: EvidenceVisibility;
  sharedWithWitnesses: boolean;
  ipAddress: string | null;
  deviceInfo: unknown;
}

const SIGNED_EVIDENCE_URL_TTL_SECONDS = 300;

/**
 * Sprint 7 (docs/sprints/SPRINT_07_Evidence_Documents_Witnesses.md) evidence-document management.
 * Deliberately holds no dependency capable of reading/writing `identity_verification_record` or any
 * bank-linking table — "Sensitive identity and banking records must not use ordinary agreement
 * evidence access" is structural here (this class cannot touch them), not just a documented rule.
 */
export class EvidenceService {
  constructor(private readonly deps: EvidenceServiceDeps) {}

  async uploadEvidence(input: UploadEvidenceInput): Promise<EvidenceRecord> {
    const detail = await this.deps.agreementService.getAgreement(input.agreementId, input.actingUserId);

    const validation = await this.deps.fileValidator.validate({
      fileName: input.fileName,
      contentType: input.contentType,
      content: input.content,
    });
    if (!validation.ok) {
      throw new ValidationError(validation.reason);
    }

    const documentHash = createHash("sha256").update(input.content).digest("hex");
    const storagePath = `${input.agreementId}/${documentHash}-${input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await this.deps.storage.uploadPrivate({ path: storagePath, content: input.content, contentType: input.contentType });

    // Frozen at upload time — never recomputed later (see evidence.ts's schema doc comment).
    const isPostSigning = detail.version.signedAt !== null;

    const record = await this.deps.evidence.insert({
      agreementId: input.agreementId,
      uploadedByUserId: input.actingUserId,
      documentType: input.documentType,
      description: input.description,
      storagePath,
      documentHash,
      fileSizeBytes: input.content.byteLength,
      contentType: input.contentType,
      isPostSigning,
      visibility: input.visibility,
      sharedWithWitnesses: input.sharedWithWitnesses,
      fileValidationStatus: "clean",
    });

    await this.recordAudit(input.actingUserId, input.agreementId, "evidence_uploaded", record.id, input.ipAddress, input.deviceInfo, {
      documentType: input.documentType,
      isPostSigning,
      visibility: input.visibility,
    });

    return record;
  }

  /**
   * Visibility rules: the uploader always sees their own evidence. A party (creditor/debtor) sees
   * every "shared" item plus their own "private" uploads, never the counterparty's private uploads.
   * A witness sees only "shared" items additionally marked `sharedWithWitnesses` — never "private"
   * evidence, regardless of that flag (a witness can never see more than an agreement party can).
   */
  async listEvidence(agreementId: string, actingUserId: string): Promise<EvidenceRecord[]> {
    const role = await this.tryResolvePartyRole(agreementId, actingUserId);
    const all = await this.deps.evidence.listForAgreement(agreementId);

    if (role) {
      return all.filter((item) => item.visibility === "shared" || item.uploadedByUserId === actingUserId);
    }

    const isWitness = await this.deps.witnesses.isActiveWitness(agreementId, actingUserId);
    if (isWitness) {
      return all.filter((item) => item.visibility === "shared" && item.sharedWithWitnesses);
    }

    throw new ForbiddenError("You do not have access to this agreement's evidence.");
  }

  async withdrawEvidence(evidenceId: string, actingUserId: string, ipAddress: string | null, deviceInfo: unknown): Promise<void> {
    const record = await this.requireEvidence(evidenceId);
    if (record.uploadedByUserId !== actingUserId) {
      throw new ForbiddenError("Only the party who uploaded this evidence may withdraw it.");
    }
    if (record.withdrawalState === "withdrawn") {
      throw new ValidationError("This evidence has already been withdrawn.");
    }
    await this.deps.evidence.updateWithdrawalState(evidenceId, "withdrawn");
    await this.recordAudit(actingUserId, record.agreementId, "evidence_withdrawn", evidenceId, ipAddress, deviceInfo, null);
  }

  async setDisputeFlag(evidenceId: string, actingUserId: string, flag: boolean, ipAddress: string | null, deviceInfo: unknown): Promise<void> {
    const record = await this.requireEvidence(evidenceId);
    const role = await this.tryResolvePartyRole(record.agreementId, actingUserId);
    if (!role) {
      throw new ForbiddenError("Only an agreement party may flag evidence for dispute.");
    }
    if (record.visibility === "private" && record.uploadedByUserId !== actingUserId) {
      throw new ForbiddenError("You do not have access to this evidence.");
    }
    await this.deps.evidence.updateDisputeFlag(evidenceId, flag);
    await this.recordAudit(actingUserId, record.agreementId, flag ? "evidence_dispute_flagged" : "evidence_dispute_unflagged", evidenceId, ipAddress, deviceInfo, null);
  }

  /** Re-runs the exact same visibility check as listEvidence before ever issuing a signed URL. */
  async getSignedEvidenceUrl(evidenceId: string, actingUserId: string): Promise<string> {
    const record = await this.requireEvidence(evidenceId);
    const visible = await this.listEvidence(record.agreementId, actingUserId);
    if (!visible.some((item) => item.id === evidenceId)) {
      throw new ForbiddenError("You do not have access to this evidence.");
    }
    return this.deps.storage.createSignedUrl(record.storagePath, SIGNED_EVIDENCE_URL_TTL_SECONDS);
  }

  private async requireEvidence(evidenceId: string): Promise<EvidenceRecord> {
    const record = await this.deps.evidence.findById(evidenceId);
    if (!record) throw new ValidationError("Evidence not found.");
    return record;
  }

  private async tryResolvePartyRole(agreementId: string, actingUserId: string): Promise<PartyRole | null> {
    try {
      return await this.deps.agreementService.resolvePartyRole(agreementId, actingUserId);
    } catch {
      return null;
    }
  }

  private async recordAudit(
    actorUserId: string,
    agreementId: string,
    action: string,
    evidenceId: string,
    ipAddress: string | null,
    deviceInfo: unknown,
    newValue: unknown,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "agreement_party",
      profileKind: null,
      profileId: null,
      agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress,
      deviceInfo,
      previousValue: null,
      newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: evidenceId,
      relatedCaseId: null,
    });
  }
}
