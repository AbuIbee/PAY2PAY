import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userAccount } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { UserAccountRecord, UserAccountRepository } from "./authService";

type UserAccountRow = typeof userAccount.$inferSelect;

function toRecord(row: UserAccountRow): UserAccountRecord {
  return {
    id: row.id,
    email: row.email,
    authCredentialRef: row.authCredentialRef,
    status: row.status,
  };
}

/**
 * Real, Postgres-backed UserAccountRepository. Not exercised by any Phase 0
 * test (no live database exists in this environment) — mirrors
 * DrizzleAuditEventRepository's pattern (src/lib/audit/drizzleAuditEventRepository.ts):
 * wired up now so the moment a real DATABASE_URL is available, AuthService
 * has a working production implementation ready.
 */
export class DrizzleUserAccountRepository implements UserAccountRepository {
  async findByEmail(email: string): Promise<UserAccountRecord | null> {
    const db = getDb();
    const rows = await db.select().from(userAccount).where(eq(userAccount.email, email)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async findById(id: string): Promise<UserAccountRecord | null> {
    const db = getDb();
    const rows = await db.select().from(userAccount).where(eq(userAccount.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async insert(input: { email: string; authCredentialRef: string }): Promise<UserAccountRecord> {
    const db = getDb();
    const [row] = await db
      .insert(userAccount)
      .values({ email: input.email, authCredentialRef: input.authCredentialRef })
      .returning();
    if (!row) {
      throw new ConfigurationError("user_account insert returned no row");
    }
    return toRecord(row);
  }
}
