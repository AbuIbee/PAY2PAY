import "server-only";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { platformBillingWebhookEvent } from "@/db/schema";
import type { PlatformBillingWebhookEventRecord, PlatformBillingWebhookEventRepository } from "./platformBillingWebhookEventRepository";

type Row = typeof platformBillingWebhookEvent.$inferSelect;

function toRecord(row: Row): PlatformBillingWebhookEventRecord {
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

export class DrizzlePlatformBillingWebhookEventRepository implements PlatformBillingWebhookEventRepository {
  /** "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-3: identical mechanism to DrizzleBusinessVerificationWebhookEventRepository.claimEvent — see that method's own doc comment. */
  async claimEvent(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
    staleClaimMs: number;
  }): Promise<PlatformBillingWebhookEventRecord | null> {
    const db = getDb();
    const now = new Date();
    const staleBefore = new Date(now.getTime() - input.staleClaimMs);
    const rows = await db
      .insert(platformBillingWebhookEvent)
      .values({
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        signatureVerified: input.signatureVerified,
        payload: input.payload,
        claimedAt: now,
      })
      .onConflictDoUpdate({
        target: [platformBillingWebhookEvent.provider, platformBillingWebhookEvent.providerEventId],
        set: { claimedAt: now },
        where: and(
          isNull(platformBillingWebhookEvent.processedAt),
          or(isNull(platformBillingWebhookEvent.claimedAt), lt(platformBillingWebhookEvent.claimedAt, staleBefore)),
        ),
      })
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markProcessed(id: string): Promise<void> {
    const db = getDb();
    await db.update(platformBillingWebhookEvent).set({ processedAt: new Date() }).where(eq(platformBillingWebhookEvent.id, id));
  }
}
