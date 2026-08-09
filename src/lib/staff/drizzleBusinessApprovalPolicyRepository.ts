import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessApprovalPolicy } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { Capability } from "./capabilities";
import type { BusinessApprovalPolicyRecord, BusinessApprovalPolicyRepository } from "./approvalService";

type Row = typeof businessApprovalPolicy.$inferSelect;

function toRecord(row: Row): BusinessApprovalPolicyRecord {
  return {
    id: row.id,
    businessProfileId: row.businessProfileId,
    capability: row.capability as Capability,
    thresholdMinorUnits: row.thresholdMinorUnits,
    requiresDualApproval: row.requiresDualApproval,
    requiresOwner: row.requiresOwner,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleBusinessApprovalPolicyRepository implements BusinessApprovalPolicyRepository {
  async upsert(input: {
    businessProfileId: string;
    capability: Capability;
    thresholdMinorUnits: number | null;
    requiresDualApproval: boolean;
    requiresOwner: boolean;
    updatedByUserId: string;
  }): Promise<BusinessApprovalPolicyRecord> {
    const db = getDb();
    const [row] = await db
      .insert(businessApprovalPolicy)
      .values(input)
      .onConflictDoUpdate({
        target: [businessApprovalPolicy.businessProfileId, businessApprovalPolicy.capability],
        set: {
          thresholdMinorUnits: input.thresholdMinorUnits,
          requiresDualApproval: input.requiresDualApproval,
          requiresOwner: input.requiresOwner,
          updatedByUserId: input.updatedByUserId,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new ConfigurationError("business_approval_policy upsert returned no row");
    return toRecord(row);
  }

  async findByBusinessAndCapability(businessProfileId: string, capability: Capability): Promise<BusinessApprovalPolicyRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessApprovalPolicy)
      .where(
        and(
          eq(businessApprovalPolicy.businessProfileId, businessProfileId),
          eq(businessApprovalPolicy.capability, capability),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listByBusiness(businessProfileId: string): Promise<BusinessApprovalPolicyRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessApprovalPolicy)
      .where(eq(businessApprovalPolicy.businessProfileId, businessProfileId));
    return rows.map(toRecord);
  }
}
