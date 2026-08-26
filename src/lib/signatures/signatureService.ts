import "server-only";
import { randomUUID } from "node:crypto";
import type { AuditService } from "@/lib/audit/auditService";
import type { MfaMethod, MfaService } from "@/lib/auth/mfaService";
import { generateAgreementPdf, hashPdfContent } from "@/lib/documents/agreementPdf";
import type { DocumentStorage } from "@/lib/documents/documentStorage";
import type { ProfileDisplayReader } from "@/lib/documents/profileDisplayReader";
import { ConfigurationError, ForbiddenError, StepUpRequiredError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
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
  /**
   * PRSprint 12 (docs/prsprints/PRSPRINT_12_ELECTRONIC_SIGNATURES_PDFS_IMMUTABLE_RECORDS.md): `id` is
   * optional so SignatureService can generate the execution/document identifier *before* rendering
   * the PDF (so the id can be printed inside the document itself — see generatePdf) and have this
   * insert use that same id, rather than only learning the id after the row already exists.
   */
  insert(input: { id?: string; agreementVersionId: string; storagePath: string; documentHash: string }): Promise<AgreementPdfRecord>;
  findByVersion(agreementVersionId: string): Promise<AgreementPdfRecord | null>;
}

export interface SignatureServiceDeps {
  agreementService: AgreementService;
  mfa: MfaService;
  staffService: StaffService;
  profileOwners: ProfileOwnerReader;
  signatureEvents: SignatureEventRepository;
  agreementPdfs: AgreementPdfRepository;
  profileDisplay: ProfileDisplayReader;
  storage: DocumentStorage;
  audit: AuditService;
  /**
   * PRSprint 13 (docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md): optional, mirroring
   * AgreementServiceDeps's own identical `notifications?` precedent — every notification call this
   * class makes is wrapped in its own try/catch (see `notifyCounterpartySigned`), so a
   * notification-layer failure can never fail the signature it's reporting on.
   */
  notifications?: NotificationService;
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
 * signing state machine — this service gates access to it (step-up, business signing authority)
 * and captures evidence around it, then delegates the actual state transition to
 * AgreementService.signAgreement, unchanged. If any gate below fails, signAgreement is never
 * called and no signature_event is recorded.
 *
 * Production follow-up (Remove Step 4 — Identity Verification): identity verification is no
 * longer part of the agreement signing gate — signing only requires a fresh step-up challenge and,
 * for a business signer, valid signing authority (account owner or an authorized staff
 * representative). This does not touch payment-provider KYC/identity functionality
 * (VerificationService, the identity-verification record repository, the admin verification
 * queue) — none of that was removed, this service simply no longer consults it before allowing a
 * signature.
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
      throw new StepUpRequiredError(
        "Step-up verification is required before signing. Please complete a fresh verification challenge and try again.",
      );
    }

    let signingAuthority: SigningAuthority | null = null;
    let signerTitle: string | null = null;
    if (party.kind === "business") {
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

    // PRSprint 12 (docs/prsprints/PRSPRINT_12_ELECTRONIC_SIGNATURES_PDFS_IMMUTABLE_RECORDS.md):
    // Sprint 5's state machine (still unchanged in every other respect — throws if the agreement
    // isn't in awaiting_signatures, if this role already signed, or if the caller isn't a party at
    // all) and this signature_event evidence row are now recorded atomically in one transaction —
    // see AgreementService.signAgreementWithEvidence and SigningApplicationRepository's own doc
    // comments for exactly what non-atomic risk this closes.
    const signResult = await this.deps.agreementService.signAgreementWithEvidence(input.agreementId, input.actingUserId, {
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
    if (!signResult.signatureEventId) {
      throw new ConfigurationError("Signing succeeded but no signature_event id was returned.");
    }
    const signatureEvent: SignatureEventRecord = {
      id: signResult.signatureEventId,
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
      signedAt: signResult.signedAt,
    };

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

    let pdfGenerated = false;
    if (signResult.bothSigned) {
      // PDF generation reads storage/schedule content the atomic signing apply above doesn't
      // return — a fresh read here is fine (never used to *decide* whether both parties have
      // signed; signResult.bothSigned, returned from inside the same transaction as the write, is
      // authoritative for that).
      const refreshed = await this.deps.agreementService.getAgreement(input.agreementId, input.actingUserId);
      const existingPdf = await this.deps.agreementPdfs.findByVersion(detail.version.id);
      if (!existingPdf) {
        await this.generatePdf(refreshed, input.ipAddress, input.deviceInfo);
        pdfGenerated = true;
      }
    }

    // PRSprint 13 (docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md): observes the signature
    // that was already atomically committed above — never able to influence whether it happened.
    // `signatureEvent.id` (this specific signature, not the agreement/version) is the dedupeKey's
    // uniqueness marker, so a later, entirely separate signature on a *different* version (an
    // amendment's own new version, e.g.) is never wrongly deduplicated against this one.
    if (signResult.bothSigned) {
      await this.notifyBothParties(detail.agreement, "agreement_signed", {}, signatureEvent.id);
    } else {
      const otherRole: PartyRole = role === "creditor" ? "debtor" : "creditor";
      await this.notifyParty(detail.agreement, otherRole, "agreement_counterparty_signed", { context: "agreement" }, signatureEvent.id);
    }

    return { signatureEvent, agreementStatus: signResult.agreementStatus, pdfGenerated };
  }

  /** Mirrors AgreementService.notifyParty's identical shape/rationale — see that method's own doc comment. */
  private async notifyParty(
    agreement: AgreementWithDetail["agreement"],
    role: PartyRole,
    notificationType: "agreement_counterparty_signed",
    payload: Record<string, unknown>,
    uniqueId: string,
  ): Promise<void> {
    if (!this.deps.notifications) return;
    try {
      const profile: ProfileRef =
        role === "creditor"
          ? { kind: agreement.creditorProfileKind, id: agreement.creditorProfileId }
          : { kind: agreement.debtorProfileKind, id: agreement.debtorProfileId };
      const recipientUserId = await this.deps.profileOwners.getOwnerUserId(profile.kind, profile.id);
      if (!recipientUserId) return;
      await this.deps.notifications.notify({
        recipientUserId,
        notificationType,
        relatedAgreementId: agreement.id,
        payload,
        dedupeKey: `${notificationType}:${agreement.id}:sig:${uniqueId}:${recipientUserId}`,
      });
    } catch (error) {
      logger.error("signature_notification_failed", {
        agreementId: agreement.id,
        notificationType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async notifyBothParties(
    agreement: AgreementWithDetail["agreement"],
    notificationType: "agreement_signed",
    payload: Record<string, unknown>,
    uniqueId: string,
  ): Promise<void> {
    if (!this.deps.notifications) return;
    try {
      const [creditorUserId, debtorUserId] = await Promise.all([
        this.deps.profileOwners.getOwnerUserId(agreement.creditorProfileKind, agreement.creditorProfileId),
        this.deps.profileOwners.getOwnerUserId(agreement.debtorProfileKind, agreement.debtorProfileId),
      ]);
      const recipients = [creditorUserId, debtorUserId].filter((id): id is string => id !== null);
      await Promise.all(
        recipients.map((recipientUserId) =>
          this.deps.notifications!.notify({
            recipientUserId,
            notificationType,
            relatedAgreementId: agreement.id,
            payload,
            dedupeKey: `${notificationType}:${agreement.id}:sig:${uniqueId}:${recipientUserId}`,
          }),
        ),
      );
    } catch (error) {
      logger.error("signature_notification_failed", {
        agreementId: agreement.id,
        notificationType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

    // PRSprint 12: generated up front so it can be printed inside the document itself (see
    // AgreementPdfRepository.insert's own doc comment), and so the "generated at" timestamp is
    // trusted server time, never anything client-supplied.
    const executionId = randomUUID();
    const generatedAt = new Date();
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
      executionId,
      generatedAt,
      // Sequential by construction (AmendmentService.applyAmendment always creates versionNumber =
      // parent.versionNumber + 1, never a gap) — avoids an extra lookup for the parent's own number.
      amendmentReference: detail.version.isOriginal
        ? null
        : { versionNumber: detail.version.versionNumber, parentVersionNumber: detail.version.versionNumber - 1 },
      // Only ever called from generatePdf, itself only called once signResult.bothSigned — this is
      // always the immutable, fully-executed record.
      isFullyExecuted: true,
    });
    const documentHash = hashPdfContent(bytes);
    const path = `${detail.agreement.id}/${versionId}.pdf`;
    await this.deps.storage.uploadPrivate({ path, content: bytes, contentType: "application/pdf" });
    await this.deps.agreementPdfs.insert({ id: executionId, agreementVersionId: versionId, storagePath: path, documentHash });

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

  /**
   * Agreement Lifecycle V2 (Part 6 — Print/PDF): a Draft/Review-state preview, generated fresh on
   * every call (never stored — this is a live view of mutable current terms, unlike the immutable
   * executed PDF above) so an authorized party can always print/save the exact current proposed
   * version. Same authorization as every other agreement read (getAgreement's authorizeEitherParty).
   * Reuses generateAgreementPdf directly with `isFullyExecuted: false` and whatever signature(s)
   * already exist on the current version (a partial signature, mid-signing, is legitimate to show).
   */
  async getPreviewPdf(agreementId: string, actingUserId: string): Promise<Uint8Array> {
    const detail = await this.deps.agreementService.getAgreement(agreementId, actingUserId);
    const [creditorName, debtorName] = await Promise.all([
      this.deps.profileDisplay.getDisplayName(detail.agreement.creditorProfileKind, detail.agreement.creditorProfileId),
      this.deps.profileDisplay.getDisplayName(detail.agreement.debtorProfileKind, detail.agreement.debtorProfileId),
    ]);
    const signatureEvents = await this.deps.signatureEvents.listForVersion(detail.version.id);
    const signatures = await Promise.all(
      signatureEvents.map(async (event) => ({
        role: event.signerRole,
        signerDisplayName: await this.deps.profileDisplay.getDisplayName(event.signerProfileKind, event.signerProfileId),
        signedAt: event.signedAt,
        authMethod: event.authMethod,
      })),
    );

    return generateAgreementPdf({
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
      documentHash: detail.version.documentHash ?? computeVersionHash(detail.version),
      executionId: randomUUID(),
      generatedAt: new Date(),
      amendmentReference: detail.version.isOriginal
        ? null
        : { versionNumber: detail.version.versionNumber, parentVersionNumber: detail.version.versionNumber - 1 },
      isFullyExecuted: !!detail.version.signedAt,
    });
  }
}
