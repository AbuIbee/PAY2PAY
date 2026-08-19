import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { cardTransactionEvent, issuedCard } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { CardTransactionEventRecord, CardTransactionEventRepository, IssuedCardRefResolver } from "./cardWebhookService";

type Row = typeof cardTransactionEvent.$inferSelect;

function toRecord(row: Row): CardTransactionEventRecord {
  return {
    id: row.id,
    issuedCardId: row.issuedCardId,
    provider: row.provider,
    providerEventId: row.providerEventId,
    eventType: row.eventType,
    providerTransactionRef: row.providerTransactionRef,
    amountMinorUnits: row.amountMinorUnits,
    currency: row.currency,
    merchantDisplayName: row.merchantDisplayName,
    signatureVerified: row.signatureVerified,
    payload: row.payload,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
  };
}

export class DrizzleCardTransactionEventRepository implements CardTransactionEventRepository {
  async findByProviderEvent(provider: string, providerEventId: string): Promise<CardTransactionEventRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(cardTransactionEvent)
      .where(and(eq(cardTransactionEvent.provider, provider), eq(cardTransactionEvent.providerEventId, providerEventId)))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async insert(input: {
    issuedCardId: string;
    provider: string;
    providerEventId: string;
    eventType: "authorization" | "clearing" | "settlement" | "decline" | "reversal";
    providerTransactionRef: string;
    amountMinorUnits: number;
    currency: string;
    merchantDisplayName: string | null;
    signatureVerified: boolean;
    payload: unknown;
  }): Promise<CardTransactionEventRecord> {
    const db = getDb();
    const [row] = await db
      .insert(cardTransactionEvent)
      .values({ ...input, payload: input.payload as object })
      .returning();
    if (!row) throw new ConfigurationError("card_transaction_event insert returned no row");
    return toRecord(row);
  }

  async markProcessed(id: string): Promise<void> {
    const db = getDb();
    await db.update(cardTransactionEvent).set({ processedAt: new Date() }).where(eq(cardTransactionEvent.id, id));
  }

  async listForCard(issuedCardId: string): Promise<CardTransactionEventRecord[]> {
    const db = getDb();
    const rows = await db.select().from(cardTransactionEvent).where(eq(cardTransactionEvent.issuedCardId, issuedCardId));
    return rows.map(toRecord);
  }
}

export class DrizzleIssuedCardRefResolver implements IssuedCardRefResolver {
  async findIdByProviderCardRef(providerCardRef: string): Promise<string | null> {
    const db = getDb();
    const rows = await db.select({ id: issuedCard.id }).from(issuedCard).where(eq(issuedCard.providerCardRef, providerCardRef)).limit(1);
    return rows[0]?.id ?? null;
  }
}
