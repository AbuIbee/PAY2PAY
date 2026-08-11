import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { paymentWebhookEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PaymentWebhookEventRecord, PaymentWebhookEventRepository } from "./paymentWebhookService";

type Row = typeof paymentWebhookEvent.$inferSelect;

function toRecord(row: Row): PaymentWebhookEventRecord {
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

export class DrizzlePaymentWebhookEventRepository implements PaymentWebhookEventRepository {
  async findByProviderEvent(provider: string, providerEventId: string): Promise<PaymentWebhookEventRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(paymentWebhookEvent)
      .where(and(eq(paymentWebhookEvent.provider, provider), eq(paymentWebhookEvent.providerEventId, providerEventId)))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async insert(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
  }): Promise<PaymentWebhookEventRecord> {
    const db = getDb();
    const [row] = await db.insert(paymentWebhookEvent).values(input).returning();
    if (!row) throw new ConfigurationError("payment_webhook_event insert returned no row");
    return toRecord(row);
  }

  async markProcessed(id: string): Promise<void> {
    const db = getDb();
    await db.update(paymentWebhookEvent).set({ processedAt: new Date() }).where(eq(paymentWebhookEvent.id, id));
  }

  async listAll(): Promise<PaymentWebhookEventRecord[]> {
    const db = getDb();
    const rows = await db.select().from(paymentWebhookEvent);
    return rows.map(toRecord);
  }
}
