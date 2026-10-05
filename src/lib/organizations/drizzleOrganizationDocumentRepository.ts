import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { organizationDocument } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { OrganizationDocumentRecord, OrganizationDocumentRepository, OrganizationDocumentType } from "./organizationDocumentRepository";

type Row = typeof organizationDocument.$inferSelect;

function toRecord(row: Row): OrganizationDocumentRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    documentType: row.documentType as OrganizationDocumentType,
    fileName: row.fileName,
    storagePath: row.storagePath,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    uploadedByUserId: row.uploadedByUserId,
    relatedAgreementId: row.relatedAgreementId,
    relatedCustomerId: row.relatedCustomerId,
    relatedObligationId: row.relatedObligationId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleOrganizationDocumentRepository implements OrganizationDocumentRepository {
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
    const db = getDb();
    const [row] = await db.insert(organizationDocument).values(input).returning();
    if (!row) throw new ConfigurationError("organization_document insert returned no row");
    return toRecord(row);
  }

  async findByIdForOrganization(organizationId: string, id: string): Promise<OrganizationDocumentRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(organizationDocument)
      .where(and(eq(organizationDocument.id, id), eq(organizationDocument.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listForOrganization(
    organizationId: string,
    filter?: { relatedAgreementId?: string; relatedCustomerId?: string; relatedObligationId?: string },
  ): Promise<OrganizationDocumentRecord[]> {
    const db = getDb();
    const conditions = [eq(organizationDocument.organizationId, organizationId)];
    if (filter?.relatedAgreementId) conditions.push(eq(organizationDocument.relatedAgreementId, filter.relatedAgreementId));
    if (filter?.relatedCustomerId) conditions.push(eq(organizationDocument.relatedCustomerId, filter.relatedCustomerId));
    if (filter?.relatedObligationId) conditions.push(eq(organizationDocument.relatedObligationId, filter.relatedObligationId));
    const rows = await db
      .select()
      .from(organizationDocument)
      .where(and(...conditions));
    return rows.map(toRecord);
  }
}
