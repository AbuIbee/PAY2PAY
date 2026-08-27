import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreementCancellationRequest } from "@/db/schema";
import type { PartyRole } from "./agreementService";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { ConfigurationError } from "@/lib/errors";
import type { AgreementCancellationRequestRecord, AgreementCancellationRequestRepository } from "./agreementCancellationService";

type Row = typeof agreementCancellationRequest.$inferSelect;

function toRecord(row: Row): AgreementCancellationRequestRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    status: row.status,
    requestedByPartyRole: row.requestedByPartyRole,
    requestedByProfileKind: row.requestedByProfileKind,
    requestedByProfileId: row.requestedByProfileId,
    reason: row.reason,
    decidedByProfileKind: row.decidedByProfileKind,
    decidedByProfileId: row.decidedByProfileId,
    rejectedReason: row.rejectedReason,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleAgreementCancellationRepository implements AgreementCancellationRequestRepository {
  async insert(input: {
    agreementId: string;
    requestedByPartyRole: PartyRole;
    requestedByProfileKind: ProfileKind;
    requestedByProfileId: string;
    reason: string;
  }): Promise<AgreementCancellationRequestRecord> {
    const db = getDb();
    const [row] = await db.insert(agreementCancellationRequest).values(input).returning();
    if (!row) throw new ConfigurationError("agreement_cancellation_request insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<AgreementCancellationRequestRecord | null> {
    const db = getDb();
    const rows = await db.select().from(agreementCancellationRequest).where(eq(agreementCancellationRequest.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForAgreement(agreementId: string): Promise<AgreementCancellationRequestRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(agreementCancellationRequest)
      .where(eq(agreementCancellationRequest.agreementId, agreementId))
      .orderBy(desc(agreementCancellationRequest.createdAt));
    return rows.map(toRecord);
  }

  async recordAccepted(id: string, decidedBy: { profileKind: ProfileKind; profileId: string }): Promise<AgreementCancellationRequestRecord> {
    const db = getDb();
    const [row] = await db
      .update(agreementCancellationRequest)
      .set({
        status: "accepted",
        decidedByProfileKind: decidedBy.profileKind,
        decidedByProfileId: decidedBy.profileId,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agreementCancellationRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("agreement_cancellation_request recordAccepted found no row");
    return toRecord(row);
  }

  async recordRejected(
    id: string,
    decidedBy: { profileKind: ProfileKind; profileId: string },
    rejectedReason: string | null,
  ): Promise<AgreementCancellationRequestRecord> {
    const db = getDb();
    const [row] = await db
      .update(agreementCancellationRequest)
      .set({
        status: "rejected",
        decidedByProfileKind: decidedBy.profileKind,
        decidedByProfileId: decidedBy.profileId,
        rejectedReason,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agreementCancellationRequest.id, id))
      .returning();
    if (!row) throw new ConfigurationError("agreement_cancellation_request recordRejected found no row");
    return toRecord(row);
  }
}
