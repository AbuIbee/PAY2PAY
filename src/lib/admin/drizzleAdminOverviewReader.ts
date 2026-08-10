import "server-only";
import { count, desc, eq, like, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, agreementPdf, auditEvent, businessProfile, personalProfile, signatureEvent, userAccount } from "@/db/schema";
import type { AdminAuditEventSummary, AdminOverviewData, AdminOverviewReader } from "./adminService";

function toAuditSummary(row: {
  id: number;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  occurredAt: Date;
  targetResourceType: string | null;
  targetResourceId: string | null;
  reason: string | null;
}): AdminAuditEventSummary {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorRole: row.actorRole,
    action: row.action,
    occurredAt: row.occurredAt.toISOString(),
    targetResourceType: row.targetResourceType,
    targetResourceId: row.targetResourceId,
    reason: row.reason,
  };
}

const AUDIT_SELECT = {
  id: auditEvent.id,
  actorUserId: auditEvent.actorUserId,
  actorRole: auditEvent.actorRole,
  action: auditEvent.action,
  occurredAt: auditEvent.occurredAt,
  targetResourceType: auditEvent.targetResourceType,
  targetResourceId: auditEvent.targetResourceId,
  reason: auditEvent.reason,
};

/**
 * Sprint 6A: every field here is a real, direct COUNT/SELECT against existing tables — "Do not
 * fabricate metrics that are not backed by real data."
 */
export class DrizzleAdminOverviewReader implements AdminOverviewReader {
  async getOverview(): Promise<AdminOverviewData> {
    const db = getDb();

    const [
      totalUsersRows,
      activeUsersRows,
      suspendedUsersRows,
      testAccountsRows,
      personalProfileRows,
      businessProfileRows,
      agreementStatusRows,
      signatureEventRows,
      agreementPdfRows,
      recentAuditRows,
      recentAdminActionRows,
    ] = await Promise.all([
      db.select({ value: count() }).from(userAccount),
      db.select({ value: count() }).from(userAccount).where(eq(userAccount.status, "active")),
      db.select({ value: count() }).from(userAccount).where(eq(userAccount.status, "suspended")),
      db.select({ value: count() }).from(userAccount).where(sql`${userAccount.accountClassification} != 'production'`),
      db.select({ value: count() }).from(personalProfile),
      db.select({ value: count() }).from(businessProfile),
      db.select({ status: agreement.status, value: count() }).from(agreement).groupBy(agreement.status),
      db.select({ value: count() }).from(signatureEvent),
      db.select({ value: count() }).from(agreementPdf),
      db.select(AUDIT_SELECT).from(auditEvent).orderBy(desc(auditEvent.id)).limit(20),
      db
        .select(AUDIT_SELECT)
        .from(auditEvent)
        .where(like(auditEvent.action, "admin\\_%"))
        .orderBy(desc(auditEvent.id))
        .limit(20),
    ]);

    const totalUsers = totalUsersRows[0]?.value ?? 0;
    const activeUsers = activeUsersRows[0]?.value ?? 0;
    const suspendedUsers = suspendedUsersRows[0]?.value ?? 0;
    const testAccounts = testAccountsRows[0]?.value ?? 0;
    const personalProfileCount = personalProfileRows[0]?.value ?? 0;
    const businessProfileCount = businessProfileRows[0]?.value ?? 0;
    const signatureEventCount = signatureEventRows[0]?.value ?? 0;
    const agreementPdfCount = agreementPdfRows[0]?.value ?? 0;

    const agreementCountsByStatus: Record<string, number> = {};
    for (const row of agreementStatusRows) {
      agreementCountsByStatus[row.status] = row.value;
    }

    return {
      totalUsers,
      activeUsers,
      suspendedUsers,
      testAccounts,
      personalProfileCount,
      businessProfileCount,
      agreementCountsByStatus,
      signatureEventCount,
      agreementPdfCount,
      recentAuditEvents: recentAuditRows.map(toAuditSummary),
      recentAdminActions: recentAdminActionRows.map(toAuditSummary),
    };
  }
}
