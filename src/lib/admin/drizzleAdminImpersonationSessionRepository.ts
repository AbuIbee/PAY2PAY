import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminImpersonationSession } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AdminImpersonationSessionRecord, AdminImpersonationSessionRepository } from "./adminService";

type Row = typeof adminImpersonationSession.$inferSelect;

function toRecord(row: Row): AdminImpersonationSessionRecord {
  return {
    id: row.id,
    adminUserId: row.adminUserId,
    targetUserId: row.targetUserId,
    reason: row.reason,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

export class DrizzleAdminImpersonationSessionRepository implements AdminImpersonationSessionRepository {
  async insert(input: { adminUserId: string; targetUserId: string; reason: string }): Promise<AdminImpersonationSessionRecord> {
    const db = getDb();
    const [row] = await db.insert(adminImpersonationSession).values(input).returning();
    if (!row) throw new ConfigurationError("admin_impersonation_session insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<AdminImpersonationSessionRecord | null> {
    const db = getDb();
    const rows = await db.select().from(adminImpersonationSession).where(eq(adminImpersonationSession.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async markEnded(id: string, endedAt: Date): Promise<void> {
    const db = getDb();
    await db.update(adminImpersonationSession).set({ endedAt }).where(eq(adminImpersonationSession.id, id));
  }

  async findActiveForAdmin(adminUserId: string): Promise<AdminImpersonationSessionRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(adminImpersonationSession)
      .where(and(eq(adminImpersonationSession.adminUserId, adminUserId), isNull(adminImpersonationSession.endedAt)))
      .orderBy(desc(adminImpersonationSession.startedAt))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }
}
