import { createHash } from "node:crypto";

export interface AuditEventPayload {
  actorUserId: string | null;
  actorRole: string | null;
  profileKind: "personal" | "business" | null;
  profileId: string | null;
  agreementId: string | null;
  action: string;
  /** ISO 8601 timestamp, caller-supplied so hashing stays deterministic and testable. */
  occurredAt: string;
  ipAddress: string | null;
  deviceInfo: unknown;
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  authStrength: string | null;
  relatedDocumentId: string | null;
  relatedCaseId: string | null;
}

const PAYLOAD_KEYS: (keyof AuditEventPayload)[] = [
  "actorUserId",
  "actorRole",
  "profileKind",
  "profileId",
  "agreementId",
  "action",
  "occurredAt",
  "ipAddress",
  "deviceInfo",
  "previousValue",
  "newValue",
  "reason",
  "authStrength",
  "relatedDocumentId",
  "relatedCaseId",
];

/**
 * Canonicalizes a payload to a stable JSON string. Only top-level key order
 * is guaranteed (via PAYLOAD_KEYS); deeply nested objects in `deviceInfo`,
 * `previousValue`, and `newValue` are serialized as-is. That's an accepted
 * Phase 0 simplification — full deep-canonicalization can be added once a
 * concrete need (e.g. cross-language hash verification) arises.
 */
function canonicalize(payload: AuditEventPayload): string {
  const ordered: Record<string, unknown> = {};
  for (const key of PAYLOAD_KEYS) {
    ordered[key] = payload[key];
  }
  return JSON.stringify(ordered);
}

/**
 * Deterministically hashes an audit event payload, chained to the previous
 * event's hash, so retroactively editing a stored row breaks the chain
 * (FR-AUDIT-003, docs/DATA_MODEL.md §6). `secret` is a server-only pepper
 * (AUDIT_HASH_SECRET) so the chain cannot be recomputed by someone with only
 * database read access.
 *
 * Pure and dependency-free by design (no env/server-only access here) so it
 * can be unit-tested directly — see src/lib/audit/hash.test.ts. Callers
 * (e.g. AuditService) are responsible for sourcing `secret` from
 * getServerEnv().AUDIT_HASH_SECRET.
 */
export function computeAuditEventHash(
  payload: AuditEventPayload,
  previousEventHash: string | null,
  secret: string,
): string {
  const hash = createHash("sha256");
  hash.update(secret);
  hash.update(previousEventHash ?? "GENESIS");
  hash.update(canonicalize(payload));
  return hash.digest("hex");
}
