import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { passwordResetToken } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PasswordResetTokenRecord, PasswordResetTokenRepository } from "./authService";

type Row = typeof passwordResetToken.$inferSelect;

function toRecord(row: Row): PasswordResetTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

export class DrizzlePasswordResetTokenRepository implements PasswordResetTokenRepository {
  async insert(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<PasswordResetTokenRecord> {
    const db = getDb();
    const [row] = await db.insert(passwordResetToken).values(input).returning();
    if (!row) {
      throw new ConfigurationError("password_reset_token insert returned no row");
    }
    return toRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(passwordResetToken)
      .where(eq(passwordResetToken.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async consume(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(passwordResetToken)
      .set({ consumedAt: new Date() })
      .where(eq(passwordResetToken.id, id));
  }
}
