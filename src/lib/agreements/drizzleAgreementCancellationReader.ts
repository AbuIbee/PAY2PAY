import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvent } from "@/db/schema";
import type { AgreementStatus } from "./agreementService";
import type { AgreementCancellationInfo, AgreementCancellationReader } from "./agreementProgressService";

/**
 * Agreement Lifecycle V2 UAT (cancellation progress display fix): a new, read-only query onto the
 * existing `audit_event` table — mirrors DrizzleAdminAuditReader's own precedent of a dedicated
 * reader class rather than expanding AuditEventRepository's minimal write-path interface. Recovers
 * the status the agreement was cancelled *from* (recorded by AgreementService.cancelAgreement's own
 * `agreement_cancelled` audit event) so AgreementProgressService can tell which steps genuinely
 * completed before cancellation versus which were still pending — the audit trail is the sole
 * source of this information, since `agreement.status` itself is overwritten to "mutually_canceled"
 * and no longer distinguishes how far the agreement had progressed.
 */
export class DrizzleAgreementCancellationReader implements AgreementCancellationReader {
  async getCancellationInfo(agreementId: string): Promise<AgreementCancellationInfo | null> {
    const db = getDb();
    const rows = await db
      .select({ newValue: auditEvent.newValue })
      .from(auditEvent)
      .where(and(eq(auditEvent.agreementId, agreementId), eq(auditEvent.action, "agreement_cancelled")))
      .orderBy(desc(auditEvent.id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const value = row.newValue as { previousStatus?: unknown } | null;
    const previousStatus = typeof value?.previousStatus === "string" ? (value.previousStatus as AgreementStatus) : null;
    if (!previousStatus) return null;
    return { previousStatus };
  }
}
