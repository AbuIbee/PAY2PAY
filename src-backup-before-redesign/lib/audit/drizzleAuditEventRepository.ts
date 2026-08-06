import "server-only";
import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AuditEventRecord, AuditEventRepository } from "./auditService";

type AuditEventRow = typeof auditEvent.$inferSelect;

function toRecord(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorRole: row.actorRole,
    profileKind: row.profileKind,
    profileId: row.profileId,
    agreementId: row.agreementId,
    action: row.action,
    occurredAt: row.occurredAt.toISOString(),
    ipAddress: row.ipAddress,
    deviceInfo: row.deviceInfo,
    previousValue: row.previousValue,
    newValue: row.newValue,
    reason: row.reason,
    authStrength: row.authStrength,
    relatedDocumentId: row.relatedDocumentId,
    relatedCaseId: row.relatedCaseId,
    eventHash: row.eventHash,
    previousEventHash: row.previousEventHash,
  };
}

/**
 * Real, Postgres-backed AuditEventRepository. Not exercised by any Phase 0
 * test (no live database exists in this environment yet) — it's wired up so
 * the moment a real DATABASE_URL is available, the AuditService has a
 * working production implementation ready, per docs/IMPLEMENTATION_PLAN.md
 * Phase 0's "Audit Service skeleton ... wired in from day one" goal.
 */
export class DrizzleAuditEventRepository implements AuditEventRepository {
  async getLastEvent(): Promise<AuditEventRecord | null> {
    const db = getDb();
    const rows = await db.select().from(auditEvent).orderBy(desc(auditEvent.id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async insertEvent(
    record: Omit<AuditEventRecord, "id">,
  ): Promise<AuditEventRecord> {
    const db = getDb();
    const [row] = await db
      .insert(auditEvent)
      .values({
        actorUserId: record.actorUserId ?? undefined,
        actorRole: record.actorRole,
        profileKind: record.profileKind ?? undefined,
        profileId: record.profileId,
        agreementId: record.agreementId,
        action: record.action,
        occurredAt: new Date(record.occurredAt),
        ipAddress: record.ipAddress,
        deviceInfo: record.deviceInfo,
        previousValue: record.previousValue,
        newValue: record.newValue,
        reason: record.reason,
        authStrength: record.authStrength,
        relatedDocumentId: record.relatedDocumentId,
        relatedCaseId: record.relatedCaseId,
        eventHash: record.eventHash,
        previousEventHash: record.previousEventHash,
      })
      .returning();
    if (!row) {
      throw new ConfigurationError("audit_event insert returned no row");
    }
    return toRecord(row);
  }
}
