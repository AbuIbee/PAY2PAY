import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessStaffMember } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { StaffRole } from "./capabilities";
import type { BusinessStaffMemberRecord, BusinessStaffMemberRepository } from "./staffService";

type Row = typeof businessStaffMember.$inferSelect;

function toRecord(row: Row): BusinessStaffMemberRecord {
  return {
    id: row.id,
    businessProfileId: row.businessProfileId,
    userId: row.userId,
    role: row.role as StaffRole,
    customRoleId: row.customRoleId,
    isAuthorizedRepresentative: row.isAuthorizedRepresentative,
    removedAt: row.removedAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleBusinessStaffMemberRepository implements BusinessStaffMemberRepository {
  async insert(input: {
    businessProfileId: string;
    userId: string;
    role: StaffRole;
    customRoleId: string | null;
    isAuthorizedRepresentative: boolean;
  }): Promise<BusinessStaffMemberRecord> {
    const db = getDb();
    const [row] = await db.insert(businessStaffMember).values(input).returning();
    if (!row) throw new ConfigurationError("business_staff_member insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<BusinessStaffMemberRecord | null> {
    const db = getDb();
    const rows = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async findActiveByBusinessAndUser(businessProfileId: string, userId: string): Promise<BusinessStaffMemberRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessStaffMember)
      .where(
        and(
          eq(businessStaffMember.businessProfileId, businessProfileId),
          eq(businessStaffMember.userId, userId),
          isNull(businessStaffMember.removedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listActiveByBusiness(businessProfileId: string): Promise<BusinessStaffMemberRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessStaffMember)
      .where(and(eq(businessStaffMember.businessProfileId, businessProfileId), isNull(businessStaffMember.removedAt)));
    return rows.map(toRecord);
  }

  async updateRole(id: string, input: { role: StaffRole; customRoleId: string | null }): Promise<void> {
    const db = getDb();
    await db
      .update(businessStaffMember)
      .set({ role: input.role, customRoleId: input.customRoleId })
      .where(eq(businessStaffMember.id, id));
  }

  async markRemoved(id: string, removedAt: Date): Promise<void> {
    const db = getDb();
    await db.update(businessStaffMember).set({ removedAt }).where(eq(businessStaffMember.id, id));
  }
}
