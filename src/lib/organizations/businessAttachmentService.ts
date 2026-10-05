import "server-only";
import { randomUUID } from "node:crypto";
import type { AgreementRepository } from "@/lib/agreements/agreementService";
import type { AuditService } from "@/lib/audit/auditService";
import type { DocumentStorage } from "@/lib/documents/documentStorage";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { sanitizeDisplayFilename, type AttachmentFileValidator } from "./attachmentFileValidator";
import type { BusinessCustomerRepository } from "./businessCustomerRepository";
import type { BusinessObligationRepository } from "./businessObligationRepository";
import type { OrganizationDocumentRecord, OrganizationDocumentRepository, OrganizationDocumentType } from "./organizationDocumentRepository";
import type { OrganizationPermissionService } from "./organizationPermissionService";

/** SCREAMING_SNAKE_CASE — mirrors PLATFORM_BILLING_AUDIT_ACTION/BUSINESS_VERIFICATION_AUDIT_ACTION's own established convention for organization-scoped events. */
export const BUSINESS_ATTACHMENT_AUDIT_ACTION = {
  UPLOADED: "BUSINESS_ATTACHMENT_UPLOADED",
} as const;

/** Exactly one supported parent resource, or none (Section 7/organization-level attachment). */
export type AttachmentParent =
  | { kind: "agreement"; id: string }
  | { kind: "customer"; id: string }
  | { kind: "obligation"; id: string }
  | { kind: "none" };

const SIGNED_URL_TTL_SECONDS = 300;

/**
 * "PAID2YOU — SECURE BUSINESS ATTACHMENTS ITERATION" (2026-10-05): the ONE centralized attachment
 * service — thin routes call this, never Storage/the repository directly (Section 14). Every
 * mutating/reading method requires BOTH an RBAC `documents.*` permission check (via
 * `OrganizationPermissionService`, which already fails closed on no org/membership/role/permission)
 * AND, when a parent resource is named, a tenant-ownership check against that SPECIFIC resource via
 * its own repository's established `findByIdForOrganization`/`findOrganizationAgreement` contract —
 * a cross-organization id is indistinguishable from a nonexistent one, so neither check can ever leak
 * existence across tenants (Section 5's own explicit "both must be true" requirement).
 */
export class BusinessAttachmentService {
  constructor(
    private readonly deps: {
      documents: OrganizationDocumentRepository;
      storage: DocumentStorage;
      audit: AuditService;
      permissions: OrganizationPermissionService;
      agreements: AgreementRepository;
      customers: BusinessCustomerRepository;
      obligations: BusinessObligationRepository;
      fileValidator: AttachmentFileValidator;
    },
  ) {}

  /** Resolves and tenant-verifies the named parent — throws ValidationError (never leaking cross-tenant existence) if it does not belong to this organization. */
  private async resolveParentLinks(
    organizationId: string,
    parent: AttachmentParent,
  ): Promise<{ relatedAgreementId: string | null; relatedCustomerId: string | null; relatedObligationId: string | null }> {
    if (parent.kind === "none") return { relatedAgreementId: null, relatedCustomerId: null, relatedObligationId: null };
    if (parent.kind === "agreement") {
      const agreement = await this.deps.agreements.findOrganizationAgreement(organizationId, parent.id);
      if (!agreement) throw new ValidationError("This organization has no such agreement to attach to.");
      return { relatedAgreementId: agreement.id, relatedCustomerId: null, relatedObligationId: null };
    }
    if (parent.kind === "customer") {
      const customer = await this.deps.customers.findByIdForOrganization(organizationId, parent.id);
      if (!customer) throw new ValidationError("This organization has no such customer to attach to.");
      return { relatedAgreementId: null, relatedCustomerId: customer.id, relatedObligationId: null };
    }
    const obligation = await this.deps.obligations.findByIdForOrganization(organizationId, parent.id);
    if (!obligation) throw new ValidationError("This organization has no such outstanding balance to attach to.");
    return { relatedAgreementId: null, relatedCustomerId: null, relatedObligationId: obligation.id };
  }

  /**
   * Upload flow (Section 10): permission -> parent resolved+tenant-verified server-side -> file
   * validated -> server-generated storage key -> Supabase private upload -> metadata persisted ->
   * audit event. Storage upload happens BEFORE the metadata insert: `DocumentStorage` has no delete
   * method, so if the metadata insert fails afterward the only residual state is an orphaned,
   * unreferenced storage object (never listed, never downloadable, functionally inert) — the safest
   * ordering available given the existing storage interface, and the caller never receives a success
   * response in that case (the insert's own thrown error propagates).
   */
  async uploadAttachment(input: {
    actingUserId: string;
    organizationId: string;
    documentType: OrganizationDocumentType;
    parent: AttachmentParent;
    fileName: string;
    contentType: string;
    content: Uint8Array;
  }): Promise<OrganizationDocumentRecord> {
    await this.deps.permissions.require(input.actingUserId, input.organizationId, "documents.upload");

    const parentLinks = await this.resolveParentLinks(input.organizationId, input.parent);

    const validation = await this.deps.fileValidator.validate({ fileName: input.fileName, contentType: input.contentType, content: input.content });
    if (!validation.ok) throw new ValidationError(validation.reason);

    const displayFileName = sanitizeDisplayFilename(input.fileName);
    // Server-generated — never a client-supplied path (Section 9). Freshly generated id, not the
    // (not-yet-created) metadata row's own id, since the storage upload happens first.
    const storagePath = `organizations/${input.organizationId}/attachments/${randomUUID()}/${displayFileName}`;

    await this.deps.storage.uploadPrivate({ path: storagePath, content: input.content, contentType: input.contentType });

    const record = await this.deps.documents.insert({
      organizationId: input.organizationId,
      documentType: input.documentType,
      fileName: displayFileName,
      storagePath,
      mimeType: input.contentType,
      sizeBytes: input.content.byteLength,
      uploadedByUserId: input.actingUserId,
      ...parentLinks,
    });

    await this.deps.audit.record({
      actorUserId: input.actingUserId,
      actorRole: "business_staff",
      profileKind: "business",
      profileId: input.organizationId,
      agreementId: parentLinks.relatedAgreementId,
      action: BUSINESS_ATTACHMENT_AUDIT_ACTION.UPLOADED,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { attachmentId: record.id, documentType: record.documentType, fileName: record.fileName },
      reason: null,
      authStrength: null,
      relatedDocumentId: record.id,
      relatedCaseId: null,
      targetResourceType: input.parent.kind,
      targetResourceId: input.parent.kind === "none" ? null : input.parent.id,
      providerEventId: null,
    });

    return record;
  }

  async listAttachments(input: { actingUserId: string; organizationId: string; parent: AttachmentParent }): Promise<OrganizationDocumentRecord[]> {
    await this.deps.permissions.require(input.actingUserId, input.organizationId, "documents.view");
    if (input.parent.kind === "none") {
      return this.deps.documents.listForOrganization(input.organizationId);
    }
    const parentLinks = await this.resolveParentLinks(input.organizationId, input.parent);
    const filter =
      parentLinks.relatedAgreementId !== null
        ? { relatedAgreementId: parentLinks.relatedAgreementId }
        : parentLinks.relatedCustomerId !== null
          ? { relatedCustomerId: parentLinks.relatedCustomerId }
          : { relatedObligationId: parentLinks.relatedObligationId! };
    return this.deps.documents.listForOrganization(input.organizationId, filter);
  }

  /**
   * Download flow (Section 11): permission -> metadata loaded + organization ownership confirmed ->
   * signed URL generated. Cross-tenant fails via `findByIdForOrganization` returning null BEFORE
   * `createSignedUrl` is ever invoked — mirrors the independently-verified signed-agreement-PDF
   * security property exactly.
   */
  async getSignedDownloadUrl(input: {
    actingUserId: string;
    organizationId: string;
    attachmentId: string;
  }): Promise<{ url: string; expiresInSeconds: number; attachment: OrganizationDocumentRecord }> {
    await this.deps.permissions.require(input.actingUserId, input.organizationId, "documents.view");
    const attachment = await this.deps.documents.findByIdForOrganization(input.organizationId, input.attachmentId);
    if (!attachment) throw new ForbiddenError("You do not have access to this attachment.");
    const url = await this.deps.storage.createSignedUrl(attachment.storagePath, SIGNED_URL_TTL_SECONDS);
    return { url, expiresInSeconds: SIGNED_URL_TTL_SECONDS, attachment };
  }
}
