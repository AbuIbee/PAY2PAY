import "server-only";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessVerificationWebhookEvent } from "@/db/schema";
import type { BusinessVerificationWebhookEventRecord, BusinessVerificationWebhookEventRepository } from "./businessVerificationWebhookEventRepository";

type Row = typeof businessVerificationWebhookEvent.$inferSelect;

function toRecord(row: Row): BusinessVerificationWebhookEventRecord {
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

export class DrizzleBusinessVerificationWebhookEventRepository implements BusinessVerificationWebhookEventRepository {
  /**
   * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-3: a single atomic
   * `INSERT ... ON CONFLICT (provider, provider_event_id) DO UPDATE ... WHERE ... RETURNING`. Postgres
   * evaluates the `WHERE` clause against the EXISTING conflicting row (if any) using its state at the
   * time of the conflict: if `processed_at` is already set (genuinely processed), or `claimed_at` is
   * still within the stale window (another delivery is actively — or very recently — processing it),
   * the `WHERE` fails to match, the UPDATE is skipped entirely, and `RETURNING` yields ZERO rows —
   * which this method reports as `null` ("duplicate, do not process"). Otherwise (no conflict at all —
   * a brand-new event — or a conflict whose row is unprocessed AND past the stale window — a safely
   * retryable failed delivery) the row is inserted or updated and returned for processing. This is the
   * ONE place "is this event safe to process right now" is decided; the webhook service itself no
   * longer makes that call via a separate find-then-insert pair (a TOCTOU race under concurrent
   * delivery, and the real source of the P0-3 "failed delivery permanently suppressed" defect).
   */
  async claimEvent(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
    staleClaimMs: number;
  }): Promise<BusinessVerificationWebhookEventRecord | null> {
    const db = getDb();
    const now = new Date();
    const staleBefore = new Date(now.getTime() - input.staleClaimMs);
    const rows = await db
      .insert(businessVerificationWebhookEvent)
      .values({
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        signatureVerified: input.signatureVerified,
        payload: input.payload,
        claimedAt: now,
      })
      .onConflictDoUpdate({
        target: [businessVerificationWebhookEvent.provider, businessVerificationWebhookEvent.providerEventId],
        set: { claimedAt: now },
        where: and(
          isNull(businessVerificationWebhookEvent.processedAt),
          or(isNull(businessVerificationWebhookEvent.claimedAt), lt(businessVerificationWebhookEvent.claimedAt, staleBefore)),
        ),
      })
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markProcessed(id: string): Promise<void> {
    const db = getDb();
    await db.update(businessVerificationWebhookEvent).set({ processedAt: new Date() }).where(eq(businessVerificationWebhookEvent.id, id));
  }
}
