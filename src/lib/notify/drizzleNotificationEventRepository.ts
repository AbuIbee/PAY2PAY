import "server-only";
import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { notificationEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { NotificationChannel, NotificationEventRecord, NotificationEventRepository, NotificationStatus } from "./notificationService";

type Row = typeof notificationEvent.$inferSelect;

function toRecord(row: Row): NotificationEventRecord {
  return {
    id: row.id,
    recipientUserId: row.recipientUserId,
    notificationType: row.notificationType,
    channel: row.channel,
    status: row.status,
    critical: row.critical,
    dedupeKey: row.dedupeKey,
    relatedPaymentAttemptId: row.relatedPaymentAttemptId,
    relatedAgreementId: row.relatedAgreementId,
    payload: row.payload as Record<string, unknown>,
    failureReason: row.failureReason,
    attemptCount: row.attemptCount,
    nextRetryAt: row.nextRetryAt,
    deliveredAt: row.deliveredAt,
    sentAt: row.sentAt,
    providerMessageId: row.providerMessageId,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}

export class DrizzleNotificationEventRepository implements NotificationEventRepository {
  async insert(input: {
    recipientUserId: string;
    notificationType: string;
    channel: NotificationChannel;
    critical: boolean;
    dedupeKey: string | null;
    relatedPaymentAttemptId: string | null;
    relatedAgreementId: string | null;
    payload: Record<string, unknown>;
  }): Promise<NotificationEventRecord> {
    const db = getDb();
    const [row] = await db.insert(notificationEvent).values(input).returning();
    if (!row) throw new ConfigurationError("notification_event insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<NotificationEventRecord | null> {
    const db = getDb();
    const rows = await db.select().from(notificationEvent).where(eq(notificationEvent.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByDedupeKey(dedupeKey: string): Promise<NotificationEventRecord | null> {
    const db = getDb();
    const rows = await db.select().from(notificationEvent).where(eq(notificationEvent.dedupeKey, dedupeKey)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByProviderMessageId(providerMessageId: string): Promise<NotificationEventRecord | null> {
    const db = getDb();
    const rows = await db.select().from(notificationEvent).where(eq(notificationEvent.providerMessageId, providerMessageId)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markSent(id: string, input: { sentAt: Date; providerMessageId: string | null }): Promise<NotificationEventRecord> {
    const db = getDb();
    const status: NotificationStatus = "sent";
    const [row] = await db
      .update(notificationEvent)
      .set({ status, sentAt: input.sentAt, providerMessageId: input.providerMessageId, failureReason: null, nextRetryAt: null })
      .where(eq(notificationEvent.id, id))
      .returning();
    if (!row) throw new ConfigurationError("notification_event markSent found no row");
    return toRecord(row);
  }

  async markDelivered(id: string, deliveredAt: Date | null): Promise<NotificationEventRecord> {
    const db = getDb();
    const status: NotificationStatus = "delivered";
    const [row] = await db
      .update(notificationEvent)
      .set({ status, deliveredAt, failureReason: null, nextRetryAt: null })
      .where(eq(notificationEvent.id, id))
      .returning();
    if (!row) throw new ConfigurationError("notification_event markDelivered found no row");
    return toRecord(row);
  }

  async markFailed(
    id: string,
    input: { failureReason: string; attemptCount: number; nextRetryAt: Date | null },
  ): Promise<NotificationEventRecord> {
    const db = getDb();
    const status: NotificationStatus = "failed";
    const [row] = await db
      .update(notificationEvent)
      .set({ status, failureReason: input.failureReason, attemptCount: input.attemptCount, nextRetryAt: input.nextRetryAt })
      .where(eq(notificationEvent.id, id))
      .returning();
    if (!row) throw new ConfigurationError("notification_event markFailed found no row");
    return toRecord(row);
  }

  async findDueForRetry(now: Date, maxAttempts: number): Promise<NotificationEventRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(notificationEvent)
      .where(and(eq(notificationEvent.status, "failed"), isNotNull(notificationEvent.nextRetryAt), lte(notificationEvent.nextRetryAt, now)));
    return rows.filter((r) => r.attemptCount < maxAttempts).map(toRecord);
  }

  async listForUser(recipientUserId: string): Promise<NotificationEventRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(notificationEvent)
      .where(eq(notificationEvent.recipientUserId, recipientUserId))
      .orderBy(desc(notificationEvent.createdAt))
      // PRSprint 26 (docs/prsprints/PRSPRINT_26_SEARCH_FILTER_PAGINATION_RECORD_MANAGEMENT.md): a hard
      // safety cap — "do not load an unbounded production dataset into the browser." Each logical
      // notification fans out to 2-3 channel rows (email/sms/in_app), so 300 raw rows covers roughly
      // the most recent 100-150 notifications, which is generous for the Notification Center's own
      // recent-activity purpose. A full incremental "load older" UI (matching AgreementsList's
      // offset-based pagination) is a reasonable follow-up, not built this PRSprint — grouping
      // (listGroupedForUser) happens after this fetch, so true offset-based pagination on the grouped
      // result needs either a dedicated grouped-count query or a materialized "logical notification"
      // table; out of scope for this pass.
      .limit(300);
    return rows.map(toRecord);
  }

  async markRead(id: string, recipientUserId: string, readAt: Date): Promise<NotificationEventRecord | null> {
    const db = getDb();
    const [row] = await db
      .update(notificationEvent)
      .set({ readAt })
      .where(and(eq(notificationEvent.id, id), eq(notificationEvent.recipientUserId, recipientUserId)))
      .returning();
    return row ? toRecord(row) : null;
  }

  async listRecentByChannel(channel: NotificationChannel, limit: number): Promise<NotificationEventRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(notificationEvent)
      .where(eq(notificationEvent.channel, channel))
      .orderBy(desc(notificationEvent.createdAt))
      .limit(limit);
    return rows.map(toRecord);
  }
}
