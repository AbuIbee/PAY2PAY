import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvent } from "@/db/schema";
import type { AuditEventRecord } from "@/lib/audit/auditService";
import type { AdminAuditReader } from "./adminCaseReviewService";

type Row = typeof auditEvent.$inferSelect;

/** `AuditEventPayload.occurredAt` is an ISO string (every writer calls `new Date().toISOString()`), but the `timestamp` column comes back from Drizzle as a `Date` — this mapping is the one field conversion needed, everything else passes through unchanged. */
function toRecord(row: Row): AuditEventRecord {
  return { ...row, occurredAt: row.occurredAt.toISOString() };
}

/** Sprint 18's "review audit logs" — a new, read-only query onto the existing `audit_event` table (Sprint 0), never a second audit mechanism. Mirrors Sprint 6A's own `DrizzleAdminOverviewReader` precedent of a dedicated read-only reader class rather than expanding `AuditEventRepository`'s minimal write-path interface. */
export class DrizzleAdminAuditReader implements AdminAuditReader {
  async listForTarget(targetResourceType: string, targetResourceId: string): Promise<AuditEventRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.targetResourceType, targetResourceType), eq(auditEvent.targetResourceId, targetResourceId)))
      .orderBy(desc(auditEvent.id));
    return rows.map(toRecord);
  }
}
