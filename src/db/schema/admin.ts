import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { userAccount } from "./identity";

/**
 * Sprint 6A (docs/sprints/SPRINT_06A_Platform_Administration_Audit_Control.md) "View As User"
 * support functionality. Deliberately not a real session/auth mechanism — starting one never
 * issues a session token for the target account and never lets the admin act as that user; it only
 * records that a bounded, reason-required, read-only viewing window is open, so the UI can show a
 * visible indicator and so AdminService.getImpersonatedView can refuse to serve data outside an
 * active window. `endedAt` null means the window is still open.
 */
export const adminImpersonationSession = pgTable("admin_impersonation_session", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  adminUserId: uuid("admin_user_id")
    .notNull()
    .references(() => userAccount.id),
  targetUserId: uuid("target_user_id")
    .notNull()
    .references(() => userAccount.id),
  reason: text("reason").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}).enableRLS();
