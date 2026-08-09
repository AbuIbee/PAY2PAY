import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailVerificationToken } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type {
  EmailVerificationTokenRecord,
  EmailVerificationTokenRepository,
} from "./authService";

type Row = typeof emailVerificationToken.$inferSelect;

function toRecord(row: Row): EmailVerificationTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

export class DrizzleEmailVerificationTokenRepository implements EmailVerificationTokenRepository {
  async insert(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<EmailVerificationTokenRecord> {
    const db = getDb();
    const [row] = await db.insert(emailVerificationToken).values(input).returning();
    if (!row) {
      throw new ConfigurationError("email_verification_token insert returned no row");
    }
    return toRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationTokenRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(emailVerificationToken)
      .where(eq(emailVerificationToken.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async consume(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(emailVerificationToken)
      .set({ consumedAt: new Date() })
      .where(eq(emailVerificationToken.id, id));
  }
}
