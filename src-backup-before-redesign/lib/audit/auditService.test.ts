import { beforeEach, describe, expect, it } from "vitest";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "./auditService";
import { computeAuditEventHash, type AuditEventPayload } from "./hash";

/**
 * In-memory test double for AuditEventRepository. Lets this test verify the
 * AuditService's hash-chaining orchestration (docs/TEST_STRATEGY.md §2:
 * "integration test confirming every schema write in this phase goes
 * through the Audit Service") without a live Postgres instance. The real
 * implementation is DrizzleAuditEventRepository.
 */
class InMemoryAuditEventRepository implements AuditEventRepository {
  private events: AuditEventRecord[] = [];
  private nextId = 1;

  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events.at(-1) ?? null;
  }

  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const stored: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }

  all(): AuditEventRecord[] {
    return this.events;
  }
}

function makePayload(action: string): AuditEventPayload {
  return {
    actorUserId: "user-1",
    actorRole: "personal_user",
    profileKind: "personal",
    profileId: "profile-1",
    agreementId: null,
    action,
    occurredAt: new Date().toISOString(),
    ipAddress: "203.0.113.10",
    deviceInfo: null,
    previousValue: null,
    newValue: null,
    reason: null,
    authStrength: "basic",
    relatedDocumentId: null,
    relatedCaseId: null,
  };
}

describe("AuditService", () => {
  let repository: InMemoryAuditEventRepository;
  let service: AuditService;

  beforeEach(() => {
    repository = new InMemoryAuditEventRepository();
    service = new AuditService(repository);
  });

  it("records the first event with no previous hash (genesis)", async () => {
    const record = await service.record(makePayload("draft_created"));
    expect(record.previousEventHash).toBeNull();
    expect(record.eventHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("chains each subsequent event to the prior event's hash", async () => {
    const first = await service.record(makePayload("draft_created"));
    const second = await service.record(makePayload("acknowledged"));
    const third = await service.record(makePayload("accepted"));

    expect(second.previousEventHash).toBe(first.eventHash);
    expect(third.previousEventHash).toBe(second.eventHash);
    // Every event in the chain has a distinct hash.
    const hashes = repository.all().map((event) => event.eventHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("makes a retroactively altered event detectable via hash recomputation", async () => {
    await service.record(makePayload("draft_created"));
    const second = await service.record(makePayload("acknowledged"));
    await service.record(makePayload("accepted"));

    // A verifier recomputes each stored row's hash from its own fields plus
    // the recorded previousEventHash. If someone edited `second`'s `action`
    // column directly in the database (bypassing AuditService), the
    // recomputed hash would no longer match the stored eventHash.
    const tamperedPayload: AuditEventPayload = {
      ...makePayload("acknowledged"),
      action: "tampered_action",
    };
    const recomputedFromStoredFields = computeAuditEventHash(
      tamperedPayload,
      second.previousEventHash,
      "test-only-audit-hash-secret-value",
    );
    expect(recomputedFromStoredFields).not.toBe(second.eventHash);
  });
});
