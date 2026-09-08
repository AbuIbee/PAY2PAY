import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { paymentWebhookEvent } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PaymentAttemptStatus } from "./paymentService";
import type { ClaimOutcome, PaymentWebhookEventRecord, PaymentWebhookEventRepository } from "./paymentWebhookService";

type Row = typeof paymentWebhookEvent.$inferSelect;

function toRecord(row: Row): PaymentWebhookEventRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.providerEventId,
    eventType: row.eventType,
    source: row.source,
    signatureVerified: row.signatureVerified,
    payload: row.payload,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
    processingStatus: row.processingStatus,
    processingAttempts: row.processingAttempts,
    processingStartedAt: row.processingStartedAt,
    lastFailedAt: row.lastFailedAt,
    lastErrorCode: row.lastErrorCode,
    nextRetryAt: row.nextRetryAt,
    leaseExpiresAt: row.leaseExpiresAt,
    claimToken: row.claimToken,
    providerPaymentId: row.providerPaymentId,
    transitionAppliedAt: row.transitionAppliedAt,
    transitionFromStatus: row.transitionFromStatus,
    transitionToStatus: row.transitionToStatus,
  };
}

/** R09 corrective pass (Codex blocker 8): extracts the trusted event's own payment identity from its payload at claim time, so it can be indexed — never re-parsed from `payload` on every reconciliation lookup. */
function extractProviderPaymentId(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "providerPaymentId" in payload) {
    const value = (payload as Record<string, unknown>).providerPaymentId;
    return typeof value === "string" ? value : null;
  }
  return null;
}

/** postgres.js/drizzle unique-violation error code (23505) — surfaces either directly on the thrown error or nested under `.cause`, mirroring drizzleAgreementRepository.ts's identical `isForeignKeyViolation` (23503) precedent. */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const causeCode = error.cause instanceof Error ? (error.cause as { code?: unknown }).code : undefined;
  return code === "23505" || causeCode === "23505";
}

/**
 * R06 (webhook processed-state / redelivery recovery) — corrective pass. See
 * `PaymentWebhookEventRepository`'s own doc comment in paymentWebhookService.ts for the full defect
 * this closes and the exact contract every method here must uphold: existence must never be treated
 * as completion, and every state transition is either a single atomic conditional statement or a
 * `SELECT ... FOR UPDATE`-guarded transaction — never a plain read followed by a separate write.
 */
export class DrizzlePaymentWebhookEventRepository implements PaymentWebhookEventRepository {
  /**
   * R07-style injectability: `db` defaults to the shared production singleton solely so
   * `*.postgres.test.ts` concurrency suites can hand this class a genuinely distinct PostgreSQL
   * connection, proving real claim/lease contention — a single shared `max: 1` connection structurally
   * cannot exhibit that. Every production call site (`new DrizzlePaymentWebhookEventRepository()`, no
   * argument) is unaffected.
   */
  constructor(private readonly db: Database = getDb()) {}

  async findByProviderEvent(provider: string, providerEventId: string): Promise<PaymentWebhookEventRecord | null> {
    const db = this.db;
    const rows = await db
      .select()
      .from(paymentWebhookEvent)
      .where(and(eq(paymentWebhookEvent.provider, provider), eq(paymentWebhookEvent.providerEventId, providerEventId)))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async tryInsertAndClaim(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    source: PaymentWebhookEventRecord["source"];
    signatureVerified: boolean;
    payload: unknown;
    leaseMs: number;
    now: Date;
  }): Promise<PaymentWebhookEventRecord | null> {
    const db = this.db;
    try {
      const [row] = await db
        .insert(paymentWebhookEvent)
        .values({
          provider: input.provider,
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          source: input.source,
          signatureVerified: input.signatureVerified,
          payload: input.payload,
          processingStatus: "processing",
          processingAttempts: 1,
          processingStartedAt: input.now,
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          claimToken: randomUUID(),
          providerPaymentId: extractProviderPaymentId(input.payload),
        })
        .returning();
      if (!row) throw new ConfigurationError("payment_webhook_event insert returned no row");
      return toRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async claimExistingForProcessing(provider: string, providerEventId: string, leaseMs: number, now: Date): Promise<ClaimOutcome> {
    const db = this.db;
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(paymentWebhookEvent)
        .where(and(eq(paymentWebhookEvent.provider, provider), eq(paymentWebhookEvent.providerEventId, providerEventId)))
        .for("update")
        .limit(1);
      const row = rows[0];
      // Only reachable after a caller's own tryInsertAndClaim hit a unique conflict, so the row must
      // exist — this null check is defense-in-depth, not an expected path.
      if (!row) return { outcome: "duplicate" };

      if (row.processingStatus === "processed") return { outcome: "duplicate" };

      if (row.processingStatus === "processing") {
        if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() > now.getTime()) {
          return { outcome: "in_progress" }; // a live worker owns this lease right now.
        }
        // Lease expired (or was somehow never set) — the holder is presumed dead; falls through to
        // the claim below. This is exactly what makes "a crashed worker must not wedge the event
        // forever" true.
      } else if (row.processingStatus === "failed") {
        if (!row.nextRetryAt) return { outcome: "not_due" }; // permanent/poison — never reclaimed here.
        if (row.nextRetryAt.getTime() > now.getTime()) return { outcome: "not_due" }; // backoff not yet elapsed.
      }
      // "received" always falls through to the claim below.

      const [updated] = await tx
        .update(paymentWebhookEvent)
        .set({
          processingStatus: "processing",
          processingAttempts: row.processingAttempts + 1,
          processingStartedAt: now,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          // R09 corrective pass (Codex blocker 2): a FRESH token on every (re)claim — the previous
          // owner's token (if any) is invalidated the instant this row is claimed here, so its
          // eventual late finalization attempt (see markProcessed/markFailedRetryable/
          // markFailedPermanent) is guaranteed to find a mismatched token and no-op.
          claimToken: randomUUID(),
        })
        .where(eq(paymentWebhookEvent.id, row.id))
        .returning();
      if (!updated) throw new ConfigurationError("payment_webhook_event claim update returned no row");
      return { outcome: "claimed", record: toRecord(updated) };
    });
  }

  async claimBatchForRecovery(limit: number, leaseMs: number, now: Date): Promise<PaymentWebhookEventRecord[]> {
    const db = this.db;
    return db.transaction(async (tx) => {
      // Bounded (LIMIT), index-backed (payment_webhook_event_recovery_scan_idx) scan — never an
      // unbounded full-table scan. `FOR UPDATE SKIP LOCKED` is what makes multiple simultaneous
      // scheduler instances (or a scheduler run overlapping a live webhook request) safe: each
      // claims a disjoint set of rows instead of blocking on, or duplicating, another's claim.
      const eligible = await tx
        .select({ id: paymentWebhookEvent.id })
        .from(paymentWebhookEvent)
        .where(
          or(
            eq(paymentWebhookEvent.processingStatus, "received"),
            and(
              eq(paymentWebhookEvent.processingStatus, "failed"),
              isNotNull(paymentWebhookEvent.nextRetryAt),
              lte(paymentWebhookEvent.nextRetryAt, now),
            ),
            and(
              eq(paymentWebhookEvent.processingStatus, "processing"),
              isNotNull(paymentWebhookEvent.leaseExpiresAt),
              lte(paymentWebhookEvent.leaseExpiresAt, now),
            ),
          ),
        )
        .orderBy(asc(paymentWebhookEvent.receivedAt))
        .limit(limit)
        .for("update", { skipLocked: true });

      if (eligible.length === 0) return [];
      // R09 corrective pass (Codex blocker 2): each row needs its OWN fresh claim token, so a single
      // bulk `UPDATE ... WHERE id IN (...)` (one shared value for every row) cannot express this —
      // one UPDATE per row, still inside this one transaction/lock scope, still `SKIP LOCKED`-safe
      // against any other concurrent scheduler run.
      const updated: Row[] = [];
      for (const { id } of eligible) {
        const [row] = await tx
          .update(paymentWebhookEvent)
          .set({
            processingStatus: "processing",
            processingAttempts: sql`${paymentWebhookEvent.processingAttempts} + 1`,
            processingStartedAt: now,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            claimToken: randomUUID(),
          })
          .where(eq(paymentWebhookEvent.id, id))
          .returning();
        if (row) updated.push(row);
      }
      return updated.map(toRecord);
    });
  }

  /** R09 corrective pass (Codex blocker 2): fenced by `claimToken` — see `PaymentWebhookEventRepository.markProcessed`'s own doc comment. A stale worker's mismatched token makes this a silent no-op. */
  async markProcessed(id: string, claimToken: string, now: Date): Promise<void> {
    const db = this.db;
    await db
      .update(paymentWebhookEvent)
      .set({ processedAt: now, processingStatus: "processed", leaseExpiresAt: null, nextRetryAt: null })
      .where(and(eq(paymentWebhookEvent.id, id), eq(paymentWebhookEvent.claimToken, claimToken)));
  }

  /** R09 corrective pass (Codex blocker 2): fenced by `claimToken` — see `markProcessed`'s own doc comment. */
  async markFailedRetryable(id: string, claimToken: string, errorCode: string, nextRetryAt: Date, now: Date): Promise<void> {
    const db = this.db;
    await db
      .update(paymentWebhookEvent)
      .set({ processingStatus: "failed", lastErrorCode: errorCode, lastFailedAt: now, nextRetryAt, leaseExpiresAt: null })
      .where(and(eq(paymentWebhookEvent.id, id), eq(paymentWebhookEvent.claimToken, claimToken)));
  }

  /** R09 corrective pass (Codex blocker 2): fenced by `claimToken` — see `markProcessed`'s own doc comment. */
  async markFailedPermanent(id: string, claimToken: string, errorCode: string, now: Date): Promise<void> {
    const db = this.db;
    await db
      .update(paymentWebhookEvent)
      .set({ processingStatus: "failed", lastErrorCode: errorCode, lastFailedAt: now, nextRetryAt: null, leaseExpiresAt: null })
      .where(and(eq(paymentWebhookEvent.id, id), eq(paymentWebhookEvent.claimToken, claimToken)));
  }

  async listAll(): Promise<PaymentWebhookEventRecord[]> {
    const db = this.db;
    const rows = await db.select().from(paymentWebhookEvent);
    return rows.map(toRecord);
  }

  /** R09 corrective pass (Codex blocker 8) — see `PaymentWebhookEventRepository.findTrustedFinancialEventsForPayment`'s own doc comment. Index-backed (`payment_webhook_event_trusted_lookup_idx`); never `listAll()`. `LIMIT 2` — the caller only ever needs to distinguish "zero" / "exactly one" / "more than one", never the full candidate set. */
  async findTrustedFinancialEventsForPayment(
    provider: string,
    providerPaymentId: string,
    eventType: string,
  ): Promise<PaymentWebhookEventRecord[]> {
    const db = this.db;
    const rows = await db
      .select()
      .from(paymentWebhookEvent)
      .where(
        and(
          eq(paymentWebhookEvent.provider, provider),
          eq(paymentWebhookEvent.providerPaymentId, providerPaymentId),
          eq(paymentWebhookEvent.eventType, eventType),
          eq(paymentWebhookEvent.processingStatus, "processed"),
          // PAID2YOU — PACKAGE B (R06+R09 architectural review remediation, Item 3 — EXACT
          // PROVENANCE PREDICATES): trusted evidence is EXACTLY one of two combinations — a
          // signed webhook (source='webhook' AND signatureVerified=true) OR an authenticated
          // provider lookup (source='provider_lookup' AND signatureVerified=false). A row with
          // source='provider_lookup' AND signatureVerified=true (never produced by this codebase's
          // own `receiveInternalEvent`, but not to be trusted merely by loose OR-composition if it
          // somehow existed) does NOT qualify, and neither does source='webhook' AND
          // signatureVerified=false (never produced either — `receiveWebhook` throws before ever
          // inserting a row on a failed signature check). See this method's own interface doc
          // comment in paymentWebhookService.ts for the full rationale.
          or(
            and(eq(paymentWebhookEvent.source, "webhook"), eq(paymentWebhookEvent.signatureVerified, true)),
            and(eq(paymentWebhookEvent.source, "provider_lookup"), eq(paymentWebhookEvent.signatureVerified, false)),
          ),
        ),
      )
      .orderBy(asc(paymentWebhookEvent.receivedAt))
      .limit(2);
    return rows.map(toRecord);
  }

  async findCanonicalTransitionEvidence(provider: string, providerPaymentId: string, targetStatus: PaymentAttemptStatus): Promise<PaymentWebhookEventRecord | null> {
    const db = this.db;
    const rows = await db
      .select()
      .from(paymentWebhookEvent)
      .where(
        and(
          eq(paymentWebhookEvent.provider, provider),
          eq(paymentWebhookEvent.providerPaymentId, providerPaymentId),
          eq(paymentWebhookEvent.transitionToStatus, targetStatus),
          isNotNull(paymentWebhookEvent.transitionAppliedAt),
          // Same exact provenance predicate as findTrustedFinancialEventsForPayment — see that
          // method's own doc comment and this method's own interface doc comment.
          or(
            and(eq(paymentWebhookEvent.source, "webhook"), eq(paymentWebhookEvent.signatureVerified, true)),
            and(eq(paymentWebhookEvent.source, "provider_lookup"), eq(paymentWebhookEvent.signatureVerified, false)),
          ),
        ),
      )
      .limit(2);
    if (rows.length !== 1) return null; // none, or ambiguous — never guessed at.
    return toRecord(rows[0]!);
  }
}
