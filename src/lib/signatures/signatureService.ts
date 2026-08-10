import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { MfaMethod, MfaService } from "@/lib/auth/mfaService";
import type { PersonalProfileRepository } from "@/lib/auth/authService";
import { generateAgreementPdf, hashPdfContent } from "@/lib/documents/agreementPdf";
import type { DocumentStorage } from "@/lib/documents/documentStorage";
import type { ProfileDisplayReader } from "@/lib/documents/profileDisplayReader";
import { ConfigurationError, ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { VerificationService } from "@/lib/profiles/verificationService";
import type { StaffService } from "@/lib/staff/staffService";
import type { AgreementService, AgreementWithDetail, PartyRole, ProfileRef } from "@/lib/agreements/agreementService";
import { computeVersionHash } from "@/lib/agreements/documentHash";

export type SigningAuthority = "account_owner" | "authorized_representative";

export interface SignatureEventRecord {
  id: string;
  agreementVersionId: string;
  signerUserId: string;
  signerProfileKind: ProfileKind;
  signerProfileId: string;
  signerRole: PartyRole;
  signingAuthority: SigningAuthority | null;
  signerTitle: string | null;
  consentCaptured: boolean;
  consentVersion: string;
  authMethod: MfaMethod;
  ipAddress: string;
  deviceInfo: unknown;
  timezone: string;
  agreementHashAtSigning: string;
  signedAt: Date;
}

/** Real implementation: DrizzleSignatureEventRepository. */
export interface SignatureEventRepository {
  insert(input: Omit<SignatureEventRecord, "id" | "signedAt">): Promise<SignatureEventRecord>;
  listForVersion(agreementVersionId: string): Promise<SignatureEventRecord[]>;
}

export interface AgreementPdfRecord {
  id: string;
  agreementVersionId: string;
  storagePath: string;
  documentHash: string;
  generatedAt: Date;
}

/** Real implementation: DrizzleAgreementPdfRepository. */
export interface AgreementPdfRepository {
  insert(input: { agreementVersionId: string; storagePath: string; documentHash: string }): Promise<AgreementPdfRecord>;
  findByVersion(agreementVersionId: string): Promise<AgreementPdfRecord | null>;
}

export interface SignatureServiceDeps {
  agreementService: AgreementService;
  mfa: MfaService;
  verification: VerificationService;
  staffService: StaffService;
  personalProfiles: PersonalProfileRepository;
  profileOwners: ProfileOwnerReader;
  signatureEvents: SignatureEventRepository;
  agreementPdfs: AgreementPdfRepository;
  profileDisplay: ProfileDisplayReader;
  storage: DocumentStorage;
  audit: AuditService;
}

export interface SignInput {
  agreementId: string;
  actingUserId: string;
  actingSessionId: string;
  authMethod: MfaMethod;
  consentVersion: string;
  ipAddress: string;
  deviceInfo: unknown;
  timezone: string;
}

export interface SignResult {
  signatureEvent: SignatureEventRecord;
  agreementStatus: string;
  pdfGenerated: boolean;
}

const SIGNED_PDF_URL_TTL_SECONDS = 300;

/**
 * Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md) electronic-signature
 * evidence capture and immutable PDF generation. Deliberately does not re-implement Sprint 5's
 * signing state machine — this service gates access to it (step-up, full verification, business
 * signing authority) and captures evidence around it, then delegates the actual state transition to
 * AgreementService.signAgreement, unchanged. If any gate below fails, signAgreement is never
 * called and no signature_event is recorded — a failed or missing step-up, or an unverified
 * profile, blocks the signature entirely, per this sprint's explicit requirement.
 */
export class SignatureService {
  constructor(private readonly deps: SignatureServiceDeps) {}

  async sign(input: SignInput): Promise<SignResult> {
    const detail = await this.deps.agreementService.getAgreement(input.agreementId, input.actingUserId);
    const role = await this.deps.agreementService.resolvePartyRole(input.agreementId, input.actingUserId);
    const party: ProfileRef =
      role === "creditor"
        ? { kind: detail.agreement.creditorProfileKind, id: detail.agreement.creditorProfileId }
        : { kind: detail.agreement.debtorProfileKind, id: detail.agreement.debtorProfileId };

    const stepUpOk = await this.deps.mfa.requireStepUp({
      userId: input.actingUserId,
      sessionId: input.actingSessionId,
      action: "sign_agreement",
    });
    if (!stepUpOk) {
      throw new ForbiddenError(
        "Step-up verification is required before signing. Please complete a fresh verification challenge and try again.",
      );
    }

    const signerPersonalProfile = await this.deps.personalProfiles.findByUserId(input.actingUserId);
    if (!signerPersonalProfile) {
      throw new ConfigurationError("No personal profile found for this account.");
    }
    const signerVerified = await this.deps.verification.isFullyVerified("personal", signerPersonalProfile.id);
    if (!signerVerified) {
      throw new ValidationError(
        "Please complete identity verification before signing this agreement. You can still use the rest of PAY2PAY in the meantime.",
      );
    }

    let signingAuthority: SigningAuthority | null = null;
    let signerTitle: string | null = null;
    if (party.kind === "business") {
      const businessVerified = await this.deps.verification.isFullyVerified("business", party.id);
      if (!businessVerified) {
        throw new ValidationError(
          "This business profile must complete verification before it can sign agreements.",
        );
      }
      const ownerUserId = await this.deps.profileOwners.getOwnerUserId("business", party.id);
      if (ownerUserId === input.actingUserId) {
        signingAuthority = "account_owner";
      } else {
        const member = await this.deps.staffService.requireActiveStaff(party.id, input.actingUserId);
        if (!member.isAuthorizedRepresentative) {
          throw new ForbiddenError(
            "This staff member is not an authorized representative for signing agreements on behalf of this business.",
          );
        }
        signingAuthority = "authorized_representative";
        signerTitle = member.role;
      }
    }

    const agreementHashAtSigning = computeVersionHash(detail.version);

    // Sprint 5's unchanged, tested state machine — throws if the agreement isn't in
    // awaiting_signatures, if this role already signed, or if the caller isn't a party at all.
    await this.deps.agreementService.signAgreement(input.agreementId, input.actingUserId);

    const signatureEvent = await this.deps.signatureEvents.insert({
      agreementVersionId: detail.version.id,
      signerUserId: input.actingUserId,
      signerProfileKind: party.kind,
      signerProfileId: party.id,
      signerRole: role,
      signingAuthority,
      signerTitle,
      consentCaptured: true,
      consentVersion: input.consentVersion,
      authMethod: input.authMethod,
      ipAddress: input.ipAddress,
      deviceInfo: input.deviceInfo ?? null,
      timezone: input.timezone,
      agreementHashAtSigning,
    });

    await this.deps.audit.record({
      actorUserId: input.actingUserId,
      actorRole: "agreement_party",
      profileKind: party.kind,
      profileId: party.id,
      agreementId: input.agreementId,
      action: "signature_event_recorded",
      occurredAt: new Date().toISOString(),
      ipAddress: input.ipAddress,
      deviceInfo: input.deviceInfo ?? null,
      previousValue: null,
      newValue: { signatureEventId: signatureEvent.id, role },
      reason: null,
      authStrength: input.authMethod,
      relatedDocumentId: null,
      relatedCaseId: null,
    });

    const refreshed = await this.deps.agreementService.getAgreement(input.agreementId, input.actingUserId);
    let pdfGenerated = false;
    const existingPdf = await this.deps.agreementPdfs.findByVersion(detail.version.id);
    if (refreshed.version.signedAt && !existingPdf) {
      await this.generatePdf(refreshed, input.ipAddress, input.deviceInfo);
      pdfGenerated = true;
    }

    return { signatureEvent, agreementStatus: refreshed.agreement.status, pdfGenerated };
  }

  private async generatePdf(detail: AgreementWithDetail, ipAddress: string, deviceInfo: unknown): Promise<void> {
    const versionId = detail.version.id;
    const [creditorName, debtorName] = await Promise.all([
      this.deps.profileDisplay.getDisplayName(detail.agreement.creditorProfileKind, detail.agreement.creditorProfileId),
      this.deps.profileDisplay.getDisplayName(detail.agreement.debtorProfileKind, detail.agreement.debtorProfileId),
    ]);
    const signatureEvents = await this.deps.signatureEvents.listForVersion(versionId);
    const signatures = await Promise.all(
      signatureEvents.map(async (event) => ({
        role: event.signerRole,
        signerDisplayName: await this.deps.profileDisplay.getDisplayName(event.signerProfileKind, event.signerProfileId),
        signedAt: event.signedAt,
        authMethod: event.authMethod,
      })),
    );

    const bytes = await generateAgreementPdf({
      agreementId: detail.agreement.id,
      versionNumber: detail.version.versionNumber,
      relationshipShape: this.deps.agreementService.relationshipShape(detail.agreement),
      currency: detail.agreement.currency,
      creditor: { kind: detail.agreement.creditorProfileKind, id: detail.agreement.creditorProfileId, displayName: creditorName },
      debtor: { kind: detail.agreement.debtorProfileKind, id: detail.agreement.debtorProfileId, displayName: debtorName },
      terms: detail.version.terms,
      frequency: detail.version.frequency,
      feeAllocation: detail.version.feeAllocation,
      schedule: detail.schedule,
      signatures,
      documentHash: detail.version.documentHash ?? "",
    });
    const documentHash = hashPdfContent(bytes);
    const path = `${detail.agreement.id}/${versionId}.pdf`;
    await this.deps.storage.uploadPrivate({ path, content: bytes, contentType: "application/pdf" });
    await this.deps.agreementPdfs.insert({ agreementVersionId: versionId, storagePath: path, documentHash });

    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "system",
      profileKind: null,
      profileId: null,
      agreementId: detail.agreement.id,
      action: "agreement_pdf_generated",
      occurredAt: new Date().toISOString(),
      ipAddress,
      deviceInfo: deviceInfo ?? null,
      previousValue: null,
      newValue: { documentHash },
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }

  /**
   * Both parties (and only both parties) may retrieve the signed PDF — AgreementService.
   * getAgreement's own authorizeEitherParty is the sole authorization check here (this sprint's
   * "document access isolation" requirement); a signed URL is short-lived and freshly issued on
   * every call, never cached or handed out once and reused indefinitely.
   */
  async getSignedPdfUrl(agreementId: string, actingUserId: string): Promise<string> {
    const detail = await this.deps.agreementService.getAgreement(agreementId, actingUserId);
    if (!detail.agreement.currentVersionId) {
      throw new ValidationError("This agreement has no current version.");
    }
    const pdf = await this.deps.agreementPdfs.findByVersion(detail.agreement.currentVersionId);
    if (!pdf) {
      throw new ValidationError("No signed PDF exists yet for this agreement.");
    }
    return this.deps.storage.createSignedUrl(pdf.storagePath, SIGNED_PDF_URL_TTL_SECONDS);
  }
}
