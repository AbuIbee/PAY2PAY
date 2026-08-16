import "server-only";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { deviceSession } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { SessionRecord, SessionRepository } from "./authService";

type DeviceSessionRow = typeof deviceSession.$inferSelect;

function toRecord(row: DeviceSessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    sessionTokenHash: row.sessionTokenHash,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
  };
}

/**
 * Real, Postgres-backed SessionRepository. Not exercised by any Phase 0 test
 * (no live database exists in this environment) — see
 * DrizzleUserAccountRepository's doc comment for why that's an accepted gap.
 */
export class DrizzleSessionRepository implements SessionRepository {
  async insert(input: {
    userId: string;
    sessionTokenHash: string;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<SessionRecord> {
    const db = getDb();
    const [row] = await db
      .insert(deviceSession)
      .values({
        userId: input.userId,
        sessionTokenHash: input.sessionTokenHash,
        expiresAt: input.expiresAt,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      })
      .returning();
    if (!row) {
      throw new ConfigurationError("device_session insert returned no row");
    }
    return toRecord(row);
  }

  async findByTokenHash(sessionTokenHash: string): Promise<SessionRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(deviceSession)
      .where(eq(deviceSession.sessionTokenHash, sessionTokenHash))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async findById(id: string): Promise<SessionRecord | null> {
    const db = getDb();
    const rows = await db.select().from(deviceSession).where(eq(deviceSession.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async revoke(id: string): Promise<void> {
    const db = getDb();
    await db.update(deviceSession).set({ revokedAt: new Date() }).where(eq(deviceSession.id, id));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const db = getDb();
    await db
      .update(deviceSession)
      .set({ revokedAt: new Date() })
      .where(eq(deviceSession.userId, userId));
  }

  async touchLastSeen(id: string): Promise<void> {
    const db = getDb();
    await db.update(deviceSession).set({ lastSeenAt: new Date() }).where(eq(deviceSession.id, id));
  }

  async listActiveForUser(userId: string, now: Date): Promise<SessionRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(deviceSession)
      .where(and(eq(deviceSession.userId, userId), isNull(deviceSession.revokedAt), gt(deviceSession.expiresAt, now)))
      .orderBy(desc(deviceSession.lastSeenAt));
    return rows.map(toRecord);
  }
}
