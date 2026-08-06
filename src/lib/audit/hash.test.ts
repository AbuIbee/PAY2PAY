import { describe, expect, it } from "vitest";
import { computeAuditEventHash, type AuditEventPayload } from "./hash";

const SECRET = "test-secret-value";

function makePayload(overrides: Partial<AuditEventPayload> = {}): AuditEventPayload {
  return {
    actorUserId: "user-1",
    actorRole: "personal_user",
    profileKind: "personal",
    profileId: "profile-1",
    agreementId: null,
    action: "draft_created",
    occurredAt: "2026-01-01T00:00:00.000Z",
    ipAddress: "203.0.113.10",
    deviceInfo: { userAgent: "test-agent" },
    previousValue: null,
    newValue: { status: "draft" },
    reason: null,
    authStrength: "basic",
    relatedDocumentId: null,
    relatedCaseId: null,
    ...overrides,
  };
}

describe("computeAuditEventHash", () => {
  it("is deterministic for identical inputs", () => {
    const payload = makePayload();
    const hash1 = computeAuditEventHash(payload, null, SECRET);
    const hash2 = computeAuditEventHash(payload, null, SECRET);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("chains to the previous event's hash — different chain position, different hash", () => {
    const payload = makePayload();
    const genesisHash = computeAuditEventHash(payload, null, SECRET);
    const chainedHash = computeAuditEventHash(payload, "some-previous-hash", SECRET);
    expect(genesisHash).not.toBe(chainedHash);
  });

  it("detects tampering: any payload change alters the hash", () => {
    const original = computeAuditEventHash(makePayload(), null, SECRET);
    const tampered = computeAuditEventHash(
      makePayload({ newValue: { status: "active" } }),
      null,
      SECRET,
    );
    expect(original).not.toBe(tampered);
  });

  it("detects a retroactively-altered chain: changing previousEventHash changes the result", () => {
    const payload = makePayload();
    const original = computeAuditEventHash(payload, "hash-a", SECRET);
    const rewritten = computeAuditEventHash(payload, "hash-b", SECRET);
    expect(original).not.toBe(rewritten);
  });

  it("depends on the secret pepper — different secrets never collide", () => {
    const payload = makePayload();
    const withSecretA = computeAuditEventHash(payload, null, "secret-a");
    const withSecretB = computeAuditEventHash(payload, null, "secret-b");
    expect(withSecretA).not.toBe(withSecretB);
  });
});
