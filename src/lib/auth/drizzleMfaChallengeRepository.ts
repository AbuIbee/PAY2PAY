import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mfaChallenge } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type {
  MfaChallengePurpose,
  MfaChallengeRecord,
  MfaChallengeRepository,
  MfaMethod,
} from "./mfaService";

type Row = typeof mfaChallenge.$inferSelect;

function toRecord(row: Row): MfaChallengeRecord {
  return {
    id: row.id,
    userId: row.userId,
    method: row.method as MfaMethod,
    codeHash: row.codeHash,
    purpose: row.purpose as MfaChallengePurpose,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    attempts: row.attempts,
  };
}

export class DrizzleMfaChallengeRepository implements MfaChallengeRepository {
  async insert(input: {
    userId: string;
    method: MfaMethod;
    codeHash: string | null;
    purpose: MfaChallengePurpose;
    expiresAt: Date;
  }): Promise<MfaChallengeRecord> {
    const db = getDb();
    const [row] = await db.insert(mfaChallenge).values(input).returning();
    if (!row) throw new ConfigurationError("mfa_challenge insert returned no row");
    return toRecord(row);
  }

  async findLatestPending(
    userId: string,
    method: MfaMethod,
    purpose: MfaChallengePurpose,
  ): Promise<MfaChallengeRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(mfaChallenge)
      .where(
        and(
          eq(mfaChallenge.userId, userId),
          eq(mfaChallenge.method, method),
          eq(mfaChallenge.purpose, purpose),
          isNull(mfaChallenge.consumedAt),
        ),
      )
      .orderBy(desc(mfaChallenge.createdAt))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async incrementAttempts(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(mfaChallenge)
      .set({ attempts: sql`${mfaChallenge.attempts} + 1` })
      .where(eq(mfaChallenge.id, id));
  }

  async consume(id: string): Promise<void> {
    const db = getDb();
    await db.update(mfaChallenge).set({ consumedAt: new Date() }).where(eq(mfaChallenge.id, id));
  }
}
