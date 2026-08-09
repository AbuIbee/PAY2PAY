import { createHash, randomBytes, randomInt } from "node:crypto";

const TOKEN_BYTES = 32;

/**
 * A cryptographically random, unguessable single-use token (email
 * verification links, password-reset links). Generalizes
 * session.ts's generateSessionToken/hashSessionToken pattern — only the hash
 * is ever persisted, never the raw token.
 */
export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A random 6-digit numeric code for SMS one-time verification. */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  return randomInt(0, max).toString().padStart(digits, "0");
}

export function hashNumericCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
