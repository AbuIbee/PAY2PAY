import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { notificationEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { NotificationEventRecord, NotificationEventRepository } from "./notificationService";

type Row = typeof notificationEvent.$inferSelect;

function toRecord(row: Row): NotificationEventRecord {
  return {
    id: row.id,
    recipientUserId: row.recipientUserId,
    notificationType: row.notificationType,
    relatedPaymentAttemptId: row.relatedPaymentAttemptId,
    relatedAgreementId: row.relatedAgreementId,
    payload: row.payload as Record<string, unknown>,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleNotificationEventRepository implements NotificationEventRepository {
  async insert(input: {
    recipientUserId: string;
    notificationType: string;
    relatedPaymentAttemptId: string | null;
    relatedAgreementId: string | null;
    payload: Record<string, unknown>;
  }): Promise<NotificationEventRecord> {
    const db = getDb();
    const [row] = await db.insert(notificationEvent).values(input).returning();
    if (!row) throw new ConfigurationError("notification_event insert returned no row");
    return toRecord(row);
  }

  async markDelivered(id: string, deliveredAt: Date): Promise<void> {
    const db = getDb();
    await db.update(notificationEvent).set({ deliveredAt }).where(eq(notificationEvent.id, id));
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
}
