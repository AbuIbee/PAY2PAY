import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { notificationPreference } from "@/db/schema";
import type { NotificationChannel, NotificationPreferenceRepository } from "./notificationService";

export class DrizzleNotificationPreferenceRepository implements NotificationPreferenceRepository {
  async find(userId: string, notificationType: string, channel: NotificationChannel): Promise<{ enabled: boolean } | null> {
    const db = getDb();
    const rows = await db
      .select({ enabled: notificationPreference.enabled })
      .from(notificationPreference)
      .where(
        and(
          eq(notificationPreference.userId, userId),
          eq(notificationPreference.notificationType, notificationType),
          eq(notificationPreference.channel, channel),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async upsert(input: { userId: string; notificationType: string; channel: NotificationChannel; enabled: boolean }): Promise<void> {
    const db = getDb();
    await db
      .insert(notificationPreference)
      .values(input)
      .onConflictDoUpdate({
        target: [notificationPreference.userId, notificationPreference.notificationType, notificationPreference.channel],
        set: { enabled: input.enabled, updatedAt: new Date() },
      });
  }

  async listForUser(userId: string): Promise<{ notificationType: string; channel: NotificationChannel; enabled: boolean }[]> {
    const db = getDb();
    return db
      .select({
        notificationType: notificationPreference.notificationType,
        channel: notificationPreference.channel,
        enabled: notificationPreference.enabled,
      })
      .from(notificationPreference)
      .where(eq(notificationPreference.userId, userId));
  }
}
