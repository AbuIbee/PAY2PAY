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

// Excludes visually ambiguous characters (0/O, 1/I) so a user reading this aloud to support, or
// typing it back in, isn't tripped up by a font/handwriting ambiguity.
const PUBLIC_REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PUBLIC_REFERENCE_LENGTH = 8;

/**
 * Section K (closed-beta remediation, Product Owner review): a short, user-facing account
 * identifier ("P2P-XXXXXXXX") — never the raw internal UUID — for support conversations and admin
 * search. Random, not sequential/derived from the user's row, so it is not enumerable: 32^8 (~1.1
 * trillion) possibilities makes a collision on insert astronomically unlikely, backstopped by the
 * database's own UNIQUE constraint rather than an app-level pre-check retry loop.
 */
export function generatePublicReferenceCode(): string {
  let code = "";
  for (let i = 0; i < PUBLIC_REFERENCE_LENGTH; i += 1) {
    code += PUBLIC_REFERENCE_ALPHABET[randomInt(0, PUBLIC_REFERENCE_ALPHABET.length)];
  }
  return `P2P-${code}`;
}

/**
 * Manual UAT remediation (#2/#3): the same non-enumerable, non-sequential alphabet/entropy as
 * generatePublicReferenceCode above, grouped into two 4-character blocks ("P2P-XXXX-XXXX") for
 * easier reading aloud/typing back on a relationship reference — purely a display/lookup identifier,
 * never a security credential (see relationship.ts's `publicReference` column doc comment: the
 * relationship_invitation token-hash flow remains the sole authority over accept/decline).
 */
export function generateRelationshipReferenceCode(): string {
  let code = "";
  for (let i = 0; i < PUBLIC_REFERENCE_LENGTH; i += 1) {
    code += PUBLIC_REFERENCE_ALPHABET[randomInt(0, PUBLIC_REFERENCE_ALPHABET.length)];
  }
  return `P2P-${code.slice(0, 4)}-${code.slice(4)}`;
}
