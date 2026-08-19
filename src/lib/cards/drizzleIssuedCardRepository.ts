import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { issuedCard } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { IssuedCardRecord, IssuedCardRepository } from "./cardService";

type Row = typeof issuedCard.$inferSelect;

function toRecord(row: Row): IssuedCardRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    individualProfileId: row.individualProfileId,
    organizationId: row.organizationId,
    cardType: row.cardType,
    providerName: row.providerName,
    providerCardRef: row.providerCardRef,
    cardLast4: row.cardLast4,
    cardBrand: row.cardBrand,
    expiresAtMonth: row.expiresAtMonth,
    expiresAtYear: row.expiresAtYear,
    status: row.status,
    shippingAddress: row.shippingAddress as Record<string, string> | null,
    activatedAt: row.activatedAt,
    frozenAt: row.frozenAt,
    frozenReason: row.frozenReason,
    closedAt: row.closedAt,
    closedReason: row.closedReason,
    supersedesCardId: row.supersedesCardId,
    requestedByUserId: row.requestedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleIssuedCardRepository implements IssuedCardRepository {
  async insert(input: {
    idempotencyKey: string;
    individualProfileId: string | null;
    organizationId: string | null;
    cardType: "virtual" | "physical";
    providerName: string;
    shippingAddress: Record<string, string> | null;
    requestedByUserId: string;
    supersedesCardId: string | null;
  }): Promise<IssuedCardRecord> {
    const db = getDb();
    const [row] = await db.insert(issuedCard).values(input).returning();
    if (!row) throw new ConfigurationError("issued_card insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<IssuedCardRecord | null> {
    const db = getDb();
    const rows = await db.select().from(issuedCard).where(eq(issuedCard.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<IssuedCardRecord | null> {
    const db = getDb();
    const rows = await db.select().from(issuedCard).where(eq(issuedCard.idempotencyKey, idempotencyKey)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByProviderCardRef(providerCardRef: string): Promise<IssuedCardRecord | null> {
    const db = getDb();
    const rows = await db.select().from(issuedCard).where(eq(issuedCard.providerCardRef, providerCardRef)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForParty(individualProfileId: string | null, organizationId: string | null): Promise<IssuedCardRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(issuedCard)
      .where(individualProfileId ? eq(issuedCard.individualProfileId, individualProfileId) : eq(issuedCard.organizationId, organizationId!));
    return rows.map(toRecord);
  }

  async markPendingIssuance(id: string): Promise<IssuedCardRecord> {
    return this.updateOne(id, { status: "pending_issuance" });
  }

  async markIssued(
    id: string,
    input: { providerCardRef: string; cardLast4: string; cardBrand: string | null; expiresAtMonth: number; expiresAtYear: number },
  ): Promise<IssuedCardRecord> {
    return this.updateOne(id, { status: "issued", ...input });
  }

  async markRequestFailed(id: string): Promise<IssuedCardRecord> {
    return this.updateOne(id, { status: "requested" });
  }

  async markActivated(id: string, activatedAt: Date): Promise<IssuedCardRecord> {
    return this.updateOne(id, { status: "active", activatedAt });
  }

  async markFrozen(id: string, frozenAt: Date, reason: string | null): Promise<IssuedCardRecord> {
    return this.updateOne(id, { status: "frozen", frozenAt, frozenReason: reason });
  }

  async markUnfrozen(id: string): Promise<IssuedCardRecord> {
    return this.updateOne(id, { status: "active", frozenAt: null, frozenReason: null });
  }

  async markLostOrStolen(id: string, status: "lost" | "stolen"): Promise<IssuedCardRecord> {
    return this.updateOne(id, { status, closedAt: new Date() });
  }

  async markReplaced(id: string, supersededBy: string): Promise<IssuedCardRecord> {
    // supersededBy is recorded on the *new* card's own supersedesCardId at insert time (see
    // cardService.ts) — this method only needs to flip the old card's status.
    void supersededBy;
    return this.updateOne(id, { status: "replaced" });
  }

  async markCanceled(id: string, closedAt: Date, reason: string): Promise<IssuedCardRecord> {
    return this.updateOne(id, { status: "canceled", closedAt, closedReason: reason });
  }

  private async updateOne(id: string, set: Partial<typeof issuedCard.$inferInsert>): Promise<IssuedCardRecord> {
    const db = getDb();
    const [row] = await db
      .update(issuedCard)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(issuedCard.id, id))
      .returning();
    if (!row) throw new ConfigurationError("issued_card update found no row");
    return toRecord(row);
  }
}
