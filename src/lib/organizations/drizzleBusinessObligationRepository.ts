import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessObligation } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { BusinessObligationRecord, BusinessObligationRepository } from "./businessObligationRepository";

type Row = typeof businessObligation.$inferSelect;

function toRecord(row: Row): BusinessObligationRecord {
  return {
    id: row.id,
    businessProfileId: row.businessProfileId,
    customerId: row.customerId,
    agreementId: row.agreementId,
    externalReference: row.externalReference,
    invoiceReference: row.invoiceReference,
    originalAmountMinorUnits: row.originalAmountMinorUnits,
    agreedAmountMinorUnits: row.agreedAmountMinorUnits,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleBusinessObligationRepository implements BusinessObligationRepository {
  async insert(input: {
    businessProfileId: string;
    customerId: string;
    agreementId?: string | null;
    externalReference?: string | null;
    invoiceReference?: string | null;
    originalAmountMinorUnits: number;
    agreedAmountMinorUnits: number;
  }): Promise<BusinessObligationRecord> {
    const db = getDb();
    const [row] = await db
      .insert(businessObligation)
      .values({
        ...input,
        agreementId: input.agreementId ?? null,
        externalReference: input.externalReference ?? null,
        invoiceReference: input.invoiceReference ?? null,
      })
      .returning();
    if (!row) throw new ConfigurationError("business_obligation insert returned no row");
    return toRecord(row);
  }

  async findByIdForOrganization(organizationId: string, obligationId: string): Promise<BusinessObligationRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessObligation)
      .where(and(eq(businessObligation.id, obligationId), eq(businessObligation.businessProfileId, organizationId)))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listForOrganization(organizationId: string): Promise<BusinessObligationRecord[]> {
    const db = getDb();
    const rows = await db.select().from(businessObligation).where(eq(businessObligation.businessProfileId, organizationId));
    return rows.map(toRecord);
  }

  async listForCustomer(organizationId: string, customerId: string): Promise<BusinessObligationRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessObligation)
      .where(and(eq(businessObligation.businessProfileId, organizationId), eq(businessObligation.customerId, customerId)));
    return rows.map(toRecord);
  }
}
