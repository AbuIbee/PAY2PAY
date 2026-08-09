import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { customRole } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { Capability } from "./capabilities";
import type { CustomRoleRecord, CustomRoleRepository } from "./staffService";

type Row = typeof customRole.$inferSelect;

function toRecord(row: Row): CustomRoleRecord {
  return {
    id: row.id,
    businessProfileId: row.businessProfileId,
    name: row.name,
    permissions: row.permissions as Capability[],
  };
}

export class DrizzleCustomRoleRepository implements CustomRoleRepository {
  async insert(input: { businessProfileId: string; name: string; permissions: Capability[] }): Promise<CustomRoleRecord> {
    const db = getDb();
    const [row] = await db.insert(customRole).values(input).returning();
    if (!row) throw new ConfigurationError("custom_role insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<CustomRoleRecord | null> {
    const db = getDb();
    const rows = await db.select().from(customRole).where(eq(customRole.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async update(id: string, input: { name?: string; permissions?: Capability[] }): Promise<void> {
    const db = getDb();
    const set: Partial<typeof customRole.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.permissions !== undefined) set.permissions = input.permissions;
    if (Object.keys(set).length === 0) return;
    await db.update(customRole).set(set).where(eq(customRole.id, id));
  }

  async listByBusiness(businessProfileId: string): Promise<CustomRoleRecord[]> {
    const db = getDb();
    const rows = await db.select().from(customRole).where(eq(customRole.businessProfileId, businessProfileId));
    return rows.map(toRecord);
  }
}
