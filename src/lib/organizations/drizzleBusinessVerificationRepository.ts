import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessVerification } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { BusinessVerificationResultStatus } from "./businessVerificationProvider";
import type { BusinessVerificationRecord, BusinessVerificationRepository } from "./businessVerificationRepository";

type Row = typeof businessVerification.$inferSelect;

function toRecord(row: Row): BusinessVerificationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    providerReference: row.providerReference,
    status: row.status,
    submittedAt: row.submittedAt,
    verifiedAt: row.verifiedAt,
    legalNameResult: row.legalNameResult,
    taxIdResult: row.taxIdResult,
    addressResult: row.addressResult,
    representativeResult: row.representativeResult,
    failureCode: row.failureCode,
    reviewRequired: row.reviewRequired,
    taxIdLast4: row.taxIdLast4,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleBusinessVerificationRepository implements BusinessVerificationRepository {
  async insertSubmission(input: { organizationId: string; provider: string; providerReference: string; taxIdLast4: string }): Promise<BusinessVerificationRecord> {
    const db = getDb();
    const [row] = await db
      .insert(businessVerification)
      .values({ ...input, status: "pending", submittedAt: new Date() })
      .returning();
    if (!row) throw new ConfigurationError("business_verification insert returned no row");
    return toRecord(row);
  }

  async findLatestForOrganization(organizationId: string): Promise<BusinessVerificationRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessVerification)
      .where(eq(businessVerification.organizationId, organizationId))
      .orderBy(desc(businessVerification.createdAt))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async findByProviderReference(providerReference: string): Promise<BusinessVerificationRecord | null> {
    const db = getDb();
    const rows = await db.select().from(businessVerification).where(eq(businessVerification.providerReference, providerReference)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async applyResult(
    id: string,
    input: {
      status: BusinessVerificationResultStatus;
      legalNameResult: string | null;
      taxIdResult: string | null;
      addressResult: string | null;
      representativeResult: string | null;
      failureCode: string | null;
      reviewRequired: boolean;
      verifiedAt: Date | null;
    },
  ): Promise<void> {
    const db = getDb();
    await db.update(businessVerification).set({ ...input, updatedAt: new Date() }).where(eq(businessVerification.id, id));
  }
}
