import "server-only";

/**
 * "PAID2YOU — SECURE BUSINESS ATTACHMENTS ITERATION" (2026-10-05): the stable Business document-type
 * vocabulary — already defined at the schema level (`organizationDocumentTypeEnum`, prepared in a
 * prior phase, DB-14) and reused verbatim here, never a second competing vocabulary.
 */
export const ORGANIZATION_DOCUMENT_TYPES = [
  "INVOICE",
  "BILL_OF_LADING",
  "PROOF_OF_DELIVERY",
  "RATE_CONFIRMATION",
  "PURCHASE_ORDER",
  "STATEMENT",
  "CONTRACT",
  "SUPPORTING_DOCUMENT",
  "OTHER",
] as const;

export type OrganizationDocumentType = (typeof ORGANIZATION_DOCUMENT_TYPES)[number];

export type OrganizationDocumentStatus = "active" | "archived";

export interface OrganizationDocumentRecord {
  id: string;
  organizationId: string;
  documentType: OrganizationDocumentType;
  /** Safe, sanitized display name only — never used to derive a storage path (see storagePath). */
  fileName: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedByUserId: string;
  /** At most one of these three is ever non-null — enforced by the DB's own CHECK constraint, never trusted from application code alone. */
  relatedAgreementId: string | null;
  relatedCustomerId: string | null;
  relatedObligationId: string | null;
  status: OrganizationDocumentStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * "PAID2YOU — SECURE BUSINESS ATTACHMENTS ITERATION" (2026-10-05): reuses the `organization_document`
 * table a prior phase (DB-14) already prepared with the correct organization-scoped shape — see that
 * table's own doc comment in platformExpansion.ts. `findByIdForOrganization` deliberately mirrors
 * `BusinessCustomerRepository`/`BusinessObligationRepository`'s own established "no bare findById"
 * contract — a cross-tenant id is indistinguishable from a nonexistent one (returns null, never an
 * error), and this is a second, independent layer of defense, never a substitute for the caller's own
 * `OrganizationPermissionService` check (see `BusinessAttachmentService`).
 */
export interface OrganizationDocumentRepository {
  insert(input: {
    organizationId: string;
    documentType: OrganizationDocumentType;
    fileName: string;
    storagePath: string;
    mimeType: string | null;
    sizeBytes: number | null;
    uploadedByUserId: string;
    relatedAgreementId: string | null;
    relatedCustomerId: string | null;
    relatedObligationId: string | null;
  }): Promise<OrganizationDocumentRecord>;
  findByIdForOrganization(organizationId: string, id: string): Promise<OrganizationDocumentRecord | null>;
  listForOrganization(
    organizationId: string,
    filter?: { relatedAgreementId?: string; relatedCustomerId?: string; relatedObligationId?: string },
  ): Promise<OrganizationDocumentRecord[]>;
}
