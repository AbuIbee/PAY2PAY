import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessProfile } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { BusinessProfileRecord, BusinessProfileRepository, BusinessProfileStatus } from "./businessProfileService";

type Row = typeof businessProfile.$inferSelect;

function toRecord(row: Row): BusinessProfileRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    legalBusinessName: row.legalBusinessName,
    displayName: row.displayName,
    entityType: row.entityType,
    businessAddress: row.businessAddress,
    country: row.country,
    state: row.state,
    status: row.status,
    currency: row.currency,
    createdAt: row.createdAt,
  };
}

export class DrizzleBusinessProfileRepository implements BusinessProfileRepository {
  async insert(input: {
    ownerUserId: string;
    legalBusinessName: string;
    displayName: string;
    entityType: string;
    businessAddress: unknown;
    country: string;
    state: string;
  }): Promise<BusinessProfileRecord> {
    const db = getDb();
    const [row] = await db
      .insert(businessProfile)
      .values({ ...input, businessAddress: input.businessAddress as object | null })
      .returning();
    if (!row) throw new ConfigurationError("business_profile insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<BusinessProfileRecord | null> {
    const db = getDb();
    const rows = await db.select().from(businessProfile).where(eq(businessProfile.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listByOwner(ownerUserId: string): Promise<BusinessProfileRecord[]> {
    const db = getDb();
    const rows = await db.select().from(businessProfile).where(eq(businessProfile.ownerUserId, ownerUserId));
    return rows.map(toRecord);
  }

  async updateStatus(id: string, status: BusinessProfileStatus): Promise<void> {
    const db = getDb();
    await db.update(businessProfile).set({ status }).where(eq(businessProfile.id, id));
  }
}
