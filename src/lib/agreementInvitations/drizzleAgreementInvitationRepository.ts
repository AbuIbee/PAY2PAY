import "server-only";
import { and, eq, inArray, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreementInvitation } from "@/db/schema";
import type {
  AgreementInvitationProposedTerms,
  AgreementInvitationRecord,
  AgreementInvitationRepository,
} from "./agreementInvitationService";

type Row = typeof agreementInvitation.$inferSelect;

function toRecord(row: Row): AgreementInvitationRecord {
  return {
    id: row.id,
    inviterUserId: row.inviterUserId,
    inviterProfileKind: row.inviterProfileKind,
    inviterProfileId: row.inviterProfileId,
    inviterRole: row.inviterRole,
    recipientName: row.recipientName,
    recipientEmail: row.recipientEmail,
    recipientPhone: row.recipientPhone,
    recipientUserId: row.recipientUserId,
    recipientProfileKind: row.recipientProfileKind,
    recipientProfileId: row.recipientProfileId,
    agreementId: row.agreementId,
    currency: row.currency,
    frequency: row.frequency,
    feeAllocation: row.feeAllocation,
    proposedTerms: row.proposedTerms as AgreementInvitationProposedTerms,
    message: row.message,
    proposalVersion: row.proposalVersion,
    tokenHash: row.tokenHash,
    status: row.status,
    expiresAt: row.expiresAt,
    openedAt: row.openedAt,
    acceptedAt: row.acceptedAt,
    declinedAt: row.declinedAt,
    revokedAt: row.revokedAt,
    claimedAt: row.claimedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleAgreementInvitationRepository implements AgreementInvitationRepository {
  async insert(input: Parameters<AgreementInvitationRepository["insert"]>[0]): Promise<AgreementInvitationRecord> {
    const db = getDb();
    const rows = await db
      .insert(agreementInvitation)
      .values({ ...input, proposedTerms: input.proposedTerms as object })
      .returning();
    return toRecord(rows[0]!);
  }

  async findById(id: string): Promise<AgreementInvitationRecord | null> {
    const db = getDb();
    const rows = await db.select().from(agreementInvitation).where(eq(agreementInvitation.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<AgreementInvitationRecord | null> {
    const db = getDb();
    const rows = await db.select().from(agreementInvitation).where(eq(agreementInvitation.tokenHash, tokenHash)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Guarded conditional update (only affects a still-`pending` row) — a lost race or an already-progressed invitation both simply fall through to the re-select below, matching AgreementInvitationService.resolvePublic's own "best effort, never throws" contract. */
  async markOpened(id: string, openedAt: Date): Promise<AgreementInvitationRecord> {
    const db = getDb();
    await db
      .update(agreementInvitation)
      .set({ status: "viewed", openedAt, updatedAt: new Date() })
      .where(and(eq(agreementInvitation.id, id), eq(agreementInvitation.status, "pending")));
    const current = await this.findById(id);
    if (!current) throw new Error("agreement_invitation not found after markOpened");
    return current;
  }

  async updateProposedTerms(
    id: string,
    input: {
      frequency: AgreementInvitationRecord["frequency"];
      feeAllocation: AgreementInvitationRecord["feeAllocation"];
      proposedTerms: AgreementInvitationProposedTerms;
      message: string | null;
      proposalVersion: number;
    },
  ): Promise<AgreementInvitationRecord> {
    const db = getDb();
    const rows = await db
      .update(agreementInvitation)
      .set({ ...input, proposedTerms: input.proposedTerms as object, updatedAt: new Date() })
      .where(eq(agreementInvitation.id, id))
      .returning();
    return toRecord(rows[0]!);
  }

  async bindRecipient(
    id: string,
    input: { recipientUserId: string; recipientProfileKind: AgreementInvitationRecord["recipientProfileKind"]; recipientProfileId: string },
  ): Promise<AgreementInvitationRecord> {
    const db = getDb();
    const rows = await db
      .update(agreementInvitation)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(agreementInvitation.id, id))
      .returning();
    return toRecord(rows[0]!);
  }

  /**
   * PRSprint 31: atomic `WHERE status IN ('pending','viewed')` — see claimAcceptance's own doc
   * comment on the AgreementInvitationRepository interface for the real financial-integrity bug this
   * closes. Returns `null`, never throws, when another decision already won the race.
   */
  async claimAcceptance(id: string, acceptedAt: Date): Promise<AgreementInvitationRecord | null> {
    const db = getDb();
    const rows = await db
      .update(agreementInvitation)
      .set({ status: "accepted", acceptedAt, updatedAt: new Date() })
      .where(and(eq(agreementInvitation.id, id), inArray(agreementInvitation.status, ["pending", "viewed"])))
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Unconditional — only ever called after claimAcceptance already won the race for this id, so there is nothing left to guard against. */
  async attachAcceptedAgreement(id: string, input: { claimedAt: Date; agreementId: string }): Promise<AgreementInvitationRecord> {
    const db = getDb();
    const rows = await db
      .update(agreementInvitation)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(agreementInvitation.id, id))
      .returning();
    return toRecord(rows[0]!);
  }

  async markDeclined(id: string, declinedAt: Date): Promise<AgreementInvitationRecord | null> {
    const db = getDb();
    const rows = await db
      .update(agreementInvitation)
      .set({ status: "declined", declinedAt, updatedAt: new Date() })
      .where(and(eq(agreementInvitation.id, id), inArray(agreementInvitation.status, ["pending", "viewed"])))
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markRevoked(id: string, revokedAt: Date): Promise<AgreementInvitationRecord | null> {
    const db = getDb();
    const rows = await db
      .update(agreementInvitation)
      .set({ status: "revoked", revokedAt, updatedAt: new Date() })
      .where(and(eq(agreementInvitation.id, id), inArray(agreementInvitation.status, ["pending", "viewed"])))
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markExpired(id: string): Promise<AgreementInvitationRecord> {
    const db = getDb();
    const rows = await db
      .update(agreementInvitation)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(agreementInvitation.id, id))
      .returning();
    return toRecord(rows[0]!);
  }

  async regenerateToken(id: string, tokenHash: string, expiresAt: Date): Promise<AgreementInvitationRecord> {
    const db = getDb();
    const rows = await db
      .update(agreementInvitation)
      .set({ tokenHash, expiresAt, updatedAt: new Date() })
      .where(eq(agreementInvitation.id, id))
      .returning();
    return toRecord(rows[0]!);
  }

  async findDueForExpiry(now: Date): Promise<AgreementInvitationRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(agreementInvitation)
      .where(and(lte(agreementInvitation.expiresAt, now), inArray(agreementInvitation.status, ["pending", "viewed"])));
    return rows.map(toRecord);
  }
}
