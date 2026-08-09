import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessStaffInvitation } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { StaffRole } from "./capabilities";
import type { StaffInvitationRecord, StaffInvitationRepository } from "./staffService";

type Row = typeof businessStaffInvitation.$inferSelect;

function toRecord(row: Row): StaffInvitationRecord {
  return {
    id: row.id,
    businessProfileId: row.businessProfileId,
    email: row.email,
    role: row.role as StaffRole,
    customRoleId: row.customRoleId,
    invitedByUserId: row.invitedByUserId,
    tokenHash: row.tokenHash,
    status: row.status,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    acceptedByUserId: row.acceptedByUserId,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleStaffInvitationRepository implements StaffInvitationRepository {
  async insert(input: {
    businessProfileId: string;
    email: string;
    role: StaffRole;
    customRoleId: string | null;
    invitedByUserId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<StaffInvitationRecord> {
    const db = getDb();
    const [row] = await db.insert(businessStaffInvitation).values(input).returning();
    if (!row) throw new ConfigurationError("business_staff_invitation insert returned no row");
    return toRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<StaffInvitationRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessStaffInvitation)
      .where(eq(businessStaffInvitation.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async findPendingByBusinessAndEmail(businessProfileId: string, email: string): Promise<StaffInvitationRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(businessStaffInvitation)
      .where(
        and(
          eq(businessStaffInvitation.businessProfileId, businessProfileId),
          eq(businessStaffInvitation.email, email),
          eq(businessStaffInvitation.status, "pending"),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async markAccepted(id: string, input: { acceptedByUserId: string; acceptedAt: Date }): Promise<void> {
    const db = getDb();
    await db
      .update(businessStaffInvitation)
      .set({ status: "accepted", acceptedByUserId: input.acceptedByUserId, acceptedAt: input.acceptedAt })
      .where(eq(businessStaffInvitation.id, id));
  }
}
