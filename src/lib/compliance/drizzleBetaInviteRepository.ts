import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { betaInviteCode } from "@/db/schema";
import type { BetaInviteCodeRecord, BetaInviteRepository } from "./betaInviteService";

type Row = typeof betaInviteCode.$inferSelect;

function toRecord(row: Row): BetaInviteCodeRecord {
  return {
    id: row.id,
    code: row.code,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    note: row.note,
    usedByUserId: row.usedByUserId,
    usedAt: row.usedAt,
  };
}

export class DrizzleBetaInviteRepository implements BetaInviteRepository {
  async insert(input: { code: string; createdByUserId: string; note: string | null }): Promise<BetaInviteCodeRecord> {
    const db = getDb();
    const [row] = await db.insert(betaInviteCode).values(input).returning();
    return toRecord(row!);
  }

  async peekCode(code: string): Promise<BetaInviteCodeRecord | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(betaInviteCode)
      .where(and(eq(betaInviteCode.code, code), isNull(betaInviteCode.usedByUserId)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async claimCode(code: string, usedByUserId: string): Promise<BetaInviteCodeRecord | null> {
    const db = getDb();
    const [row] = await db
      .update(betaInviteCode)
      .set({ usedByUserId, usedAt: new Date() })
      .where(and(eq(betaInviteCode.code, code), isNull(betaInviteCode.usedByUserId)))
      .returning();
    return row ? toRecord(row) : null;
  }

  async listAll(): Promise<BetaInviteCodeRecord[]> {
    const db = getDb();
    const rows = await db.select().from(betaInviteCode);
    return rows.map(toRecord);
  }
}
