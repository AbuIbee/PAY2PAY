import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessCustomer } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { BusinessCustomerRecord, BusinessCustomerRepository, CounterpartyProfileKind } from "./businessCustomerRepository";

type Row = typeof businessCustomer.$inferSelect;

function toRecord(row: Row): BusinessCustomerRecord {
  return {
    id: row.id,
    businessProfileId: row.businessProfileId,
    counterpartyProfileKind: row.counterpartyProfileKind as CounterpartyProfileKind,
    counterpartyProfileId: row.counterpartyProfileId,
    externalCustomerReference: row.externalCustomerReference,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleBusinessCustomerRepository implements BusinessCustomerRepository {
  async insert(input: {
    businessProfileId: string;
    counterpartyProfileKind: CounterpartyProfileKind;
    counterpartyProfileId: string;
    externalCustomerReference?: string | null;
  }): Promise<BusinessCustomerRecord> {
    const db = getDb();
    const [row] = await db
      .insert(businessCustomer)
      .values({ ...input, externalCustomerReference: input.externalCustomerReference ?? null })
      .returning();
    if (!row) throw new ConfigurationError("business_customer insert returned no row");
    return toRecord(row);
  }

  async findByIdForOrganization(organizationId: string, customerId: string): Promise<BusinessCustomerRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessCustomer)
      .where(and(eq(businessCustomer.id, customerId), eq(businessCustomer.businessProfileId, organizationId)))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listForOrganization(organizationId: string): Promise<BusinessCustomerRecord[]> {
    const db = getDb();
    const rows = await db.select().from(businessCustomer).where(eq(businessCustomer.businessProfileId, organizationId));
    return rows.map(toRecord);
  }
}
