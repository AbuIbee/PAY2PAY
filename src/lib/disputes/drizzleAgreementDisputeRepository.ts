import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreementDispute } from "@/db/schema";
import type { PartyRole } from "@/lib/agreements/agreementService";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { ConfigurationError } from "@/lib/errors";
import type {
  AgreementDisputeCategory,
  AgreementDisputeRecord,
  AgreementDisputeRepository,
} from "./agreementDisputeService";

type Row = typeof agreementDispute.$inferSelect;

function toRecord(row: Row): AgreementDisputeRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    status: row.status,
    category: row.category,
    explanation: row.explanation,
    raisedByRole: row.raisedByRole,
    raisedByProfileKind: row.raisedByProfileKind,
    raisedByProfileId: row.raisedByProfileId,
    raisedByUserId: row.raisedByUserId,
    response: row.response,
    respondedByUserId: row.respondedByUserId,
    respondedAt: row.respondedAt,
    resolutionNotes: row.resolutionNotes,
    resolvedAt: row.resolvedAt,
    resultingAmendmentId: row.resultingAmendmentId,
    restrictedReason: row.restrictedReason,
    restrictedByUserId: row.restrictedByUserId,
    restrictedAt: row.restrictedAt,
    restrictionLiftedAt: row.restrictionLiftedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleAgreementDisputeRepository implements AgreementDisputeRepository {
  async insert(input: {
    agreementId: string;
    category: AgreementDisputeCategory;
    explanation: string;
    raisedByRole: PartyRole;
    raisedByProfileKind: ProfileKind;
    raisedByProfileId: string;
    raisedByUserId: string;
  }): Promise<AgreementDisputeRecord> {
    const db = getDb();
    const [row] = await db.insert(agreementDispute).values(input).returning();
    if (!row) throw new ConfigurationError("agreement_dispute insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<AgreementDisputeRecord | null> {
    const db = getDb();
    const rows = await db.select().from(agreementDispute).where(eq(agreementDispute.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForAgreement(agreementId: string): Promise<AgreementDisputeRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(agreementDispute)
      .where(eq(agreementDispute.agreementId, agreementId))
      .orderBy(desc(agreementDispute.createdAt));
    return rows.map(toRecord);
  }

  async recordResponse(id: string, input: { response: string; respondedByUserId: string }): Promise<AgreementDisputeRecord> {
    const db = getDb();
    const [row] = await db
      .update(agreementDispute)
      .set({ status: "under_review", response: input.response, respondedByUserId: input.respondedByUserId, respondedAt: new Date(), updatedAt: new Date() })
      .where(eq(agreementDispute.id, id))
      .returning();
    if (!row) throw new ConfigurationError("agreement_dispute recordResponse found no row");
    return toRecord(row);
  }

  async recordResolvedNoChange(id: string, resolutionNotes: string | null): Promise<AgreementDisputeRecord> {
    const db = getDb();
    const [row] = await db
      .update(agreementDispute)
      .set({ status: "resolved_no_change", resolutionNotes, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(agreementDispute.id, id))
      .returning();
    if (!row) throw new ConfigurationError("agreement_dispute recordResolvedNoChange found no row");
    return toRecord(row);
  }

  async recordResolvedWithAmendment(id: string, resultingAmendmentId: string): Promise<AgreementDisputeRecord> {
    const db = getDb();
    const [row] = await db
      .update(agreementDispute)
      .set({ status: "resolved_with_amendment", resultingAmendmentId, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(agreementDispute.id, id))
      .returning();
    if (!row) throw new ConfigurationError("agreement_dispute recordResolvedWithAmendment found no row");
    return toRecord(row);
  }

  async recordRestricted(id: string, input: { reason: string; restrictedByUserId: string }): Promise<AgreementDisputeRecord> {
    const db = getDb();
    const [row] = await db
      .update(agreementDispute)
      .set({ status: "restricted", restrictedReason: input.reason, restrictedByUserId: input.restrictedByUserId, restrictedAt: new Date(), updatedAt: new Date() })
      .where(eq(agreementDispute.id, id))
      .returning();
    if (!row) throw new ConfigurationError("agreement_dispute recordRestricted found no row");
    return toRecord(row);
  }

  async recordRestrictionLifted(id: string, target: "under_review" | "closed"): Promise<AgreementDisputeRecord> {
    const db = getDb();
    const now = new Date();
    const [row] =
      target === "closed"
        ? await db
            .update(agreementDispute)
            .set({ status: "closed", restrictionLiftedAt: now, closedAt: now, updatedAt: now })
            .where(eq(agreementDispute.id, id))
            .returning()
        : await db
            .update(agreementDispute)
            .set({ status: "under_review", restrictionLiftedAt: now, updatedAt: now })
            .where(eq(agreementDispute.id, id))
            .returning();
    if (!row) throw new ConfigurationError("agreement_dispute recordRestrictionLifted found no row");
    return toRecord(row);
  }

  async recordClosed(id: string, resolutionNotes: string | null): Promise<AgreementDisputeRecord> {
    const db = getDb();
    const [row] = await db
      .update(agreementDispute)
      .set({ status: "closed", resolutionNotes, closedAt: new Date(), updatedAt: new Date() })
      .where(eq(agreementDispute.id, id))
      .returning();
    if (!row) throw new ConfigurationError("agreement_dispute recordClosed found no row");
    return toRecord(row);
  }
}
