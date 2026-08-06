import "server-only";
import { getServerEnv } from "@/config/env";
import { computeAuditEventHash, type AuditEventPayload } from "./hash";

export interface AuditEventRecord extends AuditEventPayload {
  id: number;
  eventHash: string;
  previousEventHash: string | null;
}

/**
 * Storage abstraction the AuditService writes through. Keeping this as an
 * interface (rather than calling Drizzle directly) lets Phase 0's tests
 * exercise the hash-chaining/orchestration logic against an in-memory fake
 * without a live database — see src/lib/audit/auditService.test.ts. The
 * real implementation is DrizzleAuditEventRepository
 * (src/lib/audit/drizzleAuditEventRepository.ts).
 */
export interface AuditEventRepository {
  getLastEvent(): Promise<AuditEventRecord | null>;
  insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord>;
}

/**
 * Single write path into the append-only audit trail. Every domain service
 * is expected to call AuditService.record(...) rather than writing
 * audit_event rows directly (NFR-AUDIT-002, docs/ARCHITECTURE.md §2) — no
 * such domain service exists yet in Phase 0, but this is the seam they will
 * all go through starting in Phase 1.
 */
export class AuditService {
  constructor(private readonly repository: AuditEventRepository) {}

  async record(payload: AuditEventPayload): Promise<AuditEventRecord> {
    const { AUDIT_HASH_SECRET } = getServerEnv();
    const last = await this.repository.getLastEvent();
    const previousEventHash = last?.eventHash ?? null;
    const eventHash = computeAuditEventHash(payload, previousEventHash, AUDIT_HASH_SECRET);
    return this.repository.insertEvent({ ...payload, eventHash, previousEventHash });
  }
}
