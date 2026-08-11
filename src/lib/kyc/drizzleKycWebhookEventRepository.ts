import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { kycWebhookEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { KycWebhookEventRecord, KycWebhookEventRepository } from "./kycWebhookService";

type Row = typeof kycWebhookEvent.$inferSelect;

function toRecord(row: Row): KycWebhookEventRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.providerEventId,
    eventType: row.eventType,
    signatureVerified: row.signatureVerified,
    payload: row.payload,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
  };
}

export class DrizzleKycWebhookEventRepository implements KycWebhookEventRepository {
  async findByProviderEvent(provider: string, providerEventId: string): Promise<KycWebhookEventRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(kycWebhookEvent)
      .where(and(eq(kycWebhookEvent.provider, provider), eq(kycWebhookEvent.providerEventId, providerEventId)))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async insert(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
  }): Promise<KycWebhookEventRecord> {
    const db = getDb();
    const [row] = await db.insert(kycWebhookEvent).values(input).returning();
    if (!row) throw new ConfigurationError("kyc_webhook_event insert returned no row");
    return toRecord(row);
  }

  async markProcessed(id: string): Promise<void> {
    const db = getDb();
    await db.update(kycWebhookEvent).set({ processedAt: new Date() }).where(eq(kycWebhookEvent.id, id));
  }
}
