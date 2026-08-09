import "server-only";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mfaCredential } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { MfaCredentialRecord, MfaCredentialRepository, MfaMethod } from "./mfaService";

type Row = typeof mfaCredential.$inferSelect;

function toRecord(row: Row): MfaCredentialRecord {
  return {
    id: row.id,
    userId: row.userId,
    // The DB enum also allows "passkey" (reserved, unused — see mfaService.ts's
    // doc comment); no code path in this repository ever inserts one.
    method: row.method as MfaMethod,
    secretRef: row.secretRef,
    phoneRef: row.phoneRef,
    verifiedAt: row.verifiedAt,
    disabledAt: row.disabledAt,
  };
}

export class DrizzleMfaCredentialRepository implements MfaCredentialRepository {
  async insert(input: {
    userId: string;
    method: MfaMethod;
    secretRef: string | null;
    phoneRef: string | null;
  }): Promise<MfaCredentialRecord> {
    const db = getDb();
    const [row] = await db.insert(mfaCredential).values(input).returning();
    if (!row) throw new ConfigurationError("mfa_credential insert returned no row");
    return toRecord(row);
  }

  async findLatestByUserAndMethod(userId: string, method: MfaMethod): Promise<MfaCredentialRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(mfaCredential)
      .where(
        and(eq(mfaCredential.userId, userId), eq(mfaCredential.method, method), isNull(mfaCredential.disabledAt)),
      )
      .orderBy(desc(mfaCredential.createdAt))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async findVerifiedByUserId(userId: string): Promise<MfaCredentialRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(mfaCredential)
      .where(
        and(
          eq(mfaCredential.userId, userId),
          isNotNull(mfaCredential.verifiedAt),
          isNull(mfaCredential.disabledAt),
        ),
      );
    return rows.map(toRecord);
  }

  async markVerified(id: string): Promise<void> {
    const db = getDb();
    await db.update(mfaCredential).set({ verifiedAt: new Date() }).where(eq(mfaCredential.id, id));
  }

  async disable(id: string): Promise<void> {
    const db = getDb();
    await db.update(mfaCredential).set({ disabledAt: new Date() }).where(eq(mfaCredential.id, id));
  }
}
