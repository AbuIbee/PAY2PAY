import { randomUUID } from "node:crypto";
import type { OrganizationDocumentRecord, OrganizationDocumentRepository, OrganizationDocumentType } from "./organizationDocumentRepository";

/** Test-only in-memory double — mirrors InMemoryBusinessObligationRepository's own tenant-scoped-query pattern. */
export class InMemoryOrganizationDocumentRepository implements OrganizationDocumentRepository {
  byId = new Map<string, OrganizationDocumentRecord>();

  async insert(input: {
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
  }): Promise<OrganizationDocumentRecord> {
    const record: OrganizationDocumentRecord = {
      id: randomUUID(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findByIdForOrganization(organizationId: string, id: string): Promise<OrganizationDocumentRecord | null> {
    const record = this.byId.get(id);
    if (!record || record.organizationId !== organizationId) return null;
    return record;
  }

  async listForOrganization(
    organizationId: string,
    filter?: { relatedAgreementId?: string; relatedCustomerId?: string; relatedObligationId?: string },
  ): Promise<OrganizationDocumentRecord[]> {
    return [...this.byId.values()].filter((r) => {
      if (r.organizationId !== organizationId) return false;
      if (filter?.relatedAgreementId && r.relatedAgreementId !== filter.relatedAgreementId) return false;
      if (filter?.relatedCustomerId && r.relatedCustomerId !== filter.relatedCustomerId) return false;
      if (filter?.relatedObligationId && r.relatedObligationId !== filter.relatedObligationId) return false;
      return true;
    });
  }
}
