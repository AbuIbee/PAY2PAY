import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userAccount } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { AccountClassification, PlatformRole, UserAccountRecord, UserAccountRepository } from "./authService";
import { generatePublicReferenceCode } from "./token";

type UserAccountRow = typeof userAccount.$inferSelect;

function toRecord(row: UserAccountRow): UserAccountRecord {
  return {
    id: row.id,
    email: row.email,
    authCredentialRef: row.authCredentialRef,
    status: row.status,
    platformRole: row.platformRole,
    accountClassification: row.accountClassification,
    dateOfBirth: row.dateOfBirth,
    emailVerifiedAt: row.emailVerifiedAt,
    publicReference: row.publicReference,
  };
}

/**
 * Real, Postgres-backed UserAccountRepository. Not exercised by any test
 * (no live database exists in this environment) — mirrors
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

  async insert(input: {
    email: string;
    authCredentialRef: string;
    dateOfBirth: string;
  }): Promise<UserAccountRecord> {
    const db = getDb();
    // Section K: generated here, the single place a user row is ever created, so every new signup
    // gets one immediately with no separate follow-up step. On the astronomically unlikely chance of
    // a collision, the column's UNIQUE constraint rejects the insert rather than silently overwriting
    // another user's reference — this bubbles up as an insert failure rather than being caught here.
    const [row] = await db
      .insert(userAccount)
      .values({
        email: input.email,
        authCredentialRef: input.authCredentialRef,
        dateOfBirth: input.dateOfBirth,
        publicReference: generatePublicReferenceCode(),
      })
      .returning();
    if (!row) {
      throw new ConfigurationError("user_account insert returned no row");
    }
    return toRecord(row);
  }

  async markEmailVerified(userId: string): Promise<void> {
    const db = getDb();
    await db.update(userAccount).set({ emailVerifiedAt: new Date() }).where(eq(userAccount.id, userId));
  }

  async updateLastLogin(userId: string): Promise<void> {
    const db = getDb();
    await db.update(userAccount).set({ lastLoginAt: new Date() }).where(eq(userAccount.id, userId));
  }

  async updatePasswordHash(userId: string, authCredentialRef: string): Promise<void> {
    const db = getDb();
    await db.update(userAccount).set({ authCredentialRef }).where(eq(userAccount.id, userId));
  }

  async updateStatus(userId: string, status: string): Promise<void> {
    const db = getDb();
    await db.update(userAccount).set({ status }).where(eq(userAccount.id, userId));
  }

  async updatePlatformRole(userId: string, platformRole: PlatformRole): Promise<void> {
    const db = getDb();
    await db.update(userAccount).set({ platformRole }).where(eq(userAccount.id, userId));
  }

  async updateAccountClassification(userId: string, accountClassification: AccountClassification): Promise<void> {
    const db = getDb();
    await db.update(userAccount).set({ accountClassification }).where(eq(userAccount.id, userId));
  }

  async setPublicReference(userId: string, publicReference: string): Promise<void> {
    const db = getDb();
    await db.update(userAccount).set({ publicReference }).where(eq(userAccount.id, userId));
  }

  async findByPublicReference(publicReference: string): Promise<UserAccountRecord | null> {
    const db = getDb();
    const rows = await db.select().from(userAccount).where(eq(userAccount.publicReference, publicReference)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }
}
