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
      .orderBy(desc(notificationEvent.createdAt));
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
}
