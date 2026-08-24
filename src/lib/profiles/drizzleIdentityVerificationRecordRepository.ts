import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { identityVerificationRecord } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type {
  IdentityVerificationRecordRecord,
  IdentityVerificationRecordRepository,
  ProfileKind,
  VerificationRecordStatus,
  VerificationTier,
} from "./verificationService";

type Row = typeof identityVerificationRecord.$inferSelect;

function toRecord(row: Row): IdentityVerificationRecordRecord {
  return {
    id: row.id,
    profileKind: row.profileKind,
    profileId: row.profileId,
    tier: row.tier,
    status: row.status,
    reviewerUserId: row.reviewerUserId,
    providerRef: row.providerRef,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt,
  };
}

export class DrizzleIdentityVerificationRecordRepository implements IdentityVerificationRecordRepository {
  async insert(input: {
    profileKind: ProfileKind;
    profileId: string;
    tier: VerificationTier;
  }): Promise<IdentityVerificationRecordRecord> {
    const db = getDb();
    const [row] = await db.insert(identityVerificationRecord).values(input).returning();
    if (!row) throw new ConfigurationError("identity_verification_record insert returned no row");
    return toRecord(row);
  }

  async findLatestByProfile(
    profileKind: ProfileKind,
    profileId: string,
  ): Promise<IdentityVerificationRecordRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(identityVerificationRecord)
      .where(
        and(
          eq(identityVerificationRecord.profileKind, profileKind),
          eq(identityVerificationRecord.profileId, profileId),
        ),
      )
      .orderBy(desc(identityVerificationRecord.createdAt))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async updateDecision(
    id: string,
    input: { status: "verified" | "rejected"; reviewerUserId: string | null; reason: string | null },
  ): Promise<void> {
    const db = getDb();
    await db
      .update(identityVerificationRecord)
      .set({
        status: input.status as VerificationRecordStatus,
        reviewerUserId: input.reviewerUserId,
        decisionReason: input.reason,
        decidedAt: new Date(),
      })
      .where(eq(identityVerificationRecord.id, id));
  }

  async attachProviderRef(id: string, providerRef: string): Promise<void> {
    const db = getDb();
    await db.update(identityVerificationRecord).set({ providerRef }).where(eq(identityVerificationRecord.id, id));
  }

  async findByProviderRef(providerRef: string): Promise<IdentityVerificationRecordRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(identityVerificationRecord)
      .where(eq(identityVerificationRecord.providerRef, providerRef))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listPending(): Promise<IdentityVerificationRecordRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(identityVerificationRecord)
      .where(eq(identityVerificationRecord.status, "pending"))
      .orderBy(desc(identityVerificationRecord.createdAt));
    return rows.map(toRecord);
  }
}
