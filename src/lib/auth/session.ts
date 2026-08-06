import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

/** A cryptographically random, unguessable session token (sent to the client, never stored raw). */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * SHA-256 of a session token. `device_session.session_token_hash` stores
 * only this — never the raw token — so reading the database can't be used
 * to replay a session (see src/db/schema/identity.ts's deviceSession doc
 * comment).
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
