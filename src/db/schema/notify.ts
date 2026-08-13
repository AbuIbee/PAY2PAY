import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { notificationChannelEnum } from "./enums";
import { userAccount } from "./identity";

/**
 * Sprint 17 (docs/sprints/SPRINT_17_Notifications.md): a user's explicit preference for one
 * (notification type, channel) pair. Absence of a row means "enabled" (the default) — a user only
 * ever gets a row here once they've touched that specific type/channel's toggle, never a full
 * enabled/disabled matrix seeded up front for every user. "Critical notifications cannot be
 * disabled" (this sprint's own instruction, verbatim) is enforced by `NotificationService` never even
 * querying this table for a critical event type — a row here for a critical type, however it got
 * created, is structurally inert, not merely ignored by convention.
 */
export const notificationPreference = pgTable(
  "notification_preference",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccount.id),
    notificationType: text("notification_type").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    enabled: boolean("enabled").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("notification_preference_user_type_channel_unique").on(table.userId, table.notificationType, table.channel)],
).enableRLS();
