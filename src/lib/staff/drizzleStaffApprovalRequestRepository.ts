import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { staffApprovalRequest } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { Capability } from "./capabilities";
import type { StaffApprovalRequestRecord, StaffApprovalRequestRepository } from "./approvalService";

type Row = typeof staffApprovalRequest.$inferSelect;

function toRecord(row: Row): StaffApprovalRequestRecord {
  return {
    id: row.id,
    businessProfileId: row.businessProfileId,
    proposedByStaffId: row.proposedByStaffId,
    relatedAgreementId: row.relatedAgreementId,
    actionType: row.actionType as Capability,
    actionPayload: row.actionPayload,
    reasonFlagged: row.reasonFlagged,
    status: row.status,
    approvedByStaffId: row.approvedByStaffId,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleStaffApprovalRequestRepository implements StaffApprovalRequestRepository {
  async insert(input: {
    businessProfileId: string;
    proposedByStaffId: string;
    relatedAgreementId: string | null;
    actionType: Capability;
    actionPayload: unknown;
    reasonFlagged: string;
  }): Promise<StaffApprovalRequestRecord> {
    const db = getDb();
    const [row] = await db
      .insert(staffApprovalRequest)
      .values({ ...input, actionPayload: input.actionPayload as object })
      .returning();
    if (!row) throw new ConfigurationError("staff_approval_request insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<StaffApprovalRequestRecord | null> {
    const db = getDb();
    const rows = await db.select().from(staffApprovalRequest).where(eq(staffApprovalRequest.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async updateDecision(
    id: string,
    input: { status: "approved" | "rejected"; approvedByStaffId: string; decidedAt: Date },
  ): Promise<void> {
    const db = getDb();
    await db
      .update(staffApprovalRequest)
      .set({ status: input.status, approvedByStaffId: input.approvedByStaffId, decidedAt: input.decidedAt })
      .where(eq(staffApprovalRequest.id, id));
  }

  async listPendingByBusiness(businessProfileId: string): Promise<StaffApprovalRequestRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(staffApprovalRequest)
      .where(and(eq(staffApprovalRequest.businessProfileId, businessProfileId), eq(staffApprovalRequest.status, "pending")))
      .orderBy(desc(staffApprovalRequest.createdAt));
    return rows.map(toRecord);
  }
}
