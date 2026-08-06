import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Promise wrapper around node:crypto's callback-style scrypt, written by
 * hand (rather than `promisify`) because scrypt's options-object overload
 * doesn't resolve cleanly through `promisify`'s overload picking.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * A well-formed but unusable scrypt hash, used only to burn equivalent CPU
 * time when verifying a password against an email that doesn't exist — so
 * "wrong password" and "no such account" take the same amount of time and
 * can't be distinguished by a timing attack (see verifyPassword's caller in
 * AuthService.login).
 */
export const UNUSABLE_PASSWORD_HASH = [
  "scrypt",
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  "00".repeat(SALT_LENGTH),
  "00".repeat(KEY_LENGTH),
].join("$");

/**
 * Hashes a password with scrypt, salted per-call and peppered with a
 * server-only secret (AUTH_PASSWORD_PEPPER) so a stolen database alone isn't
 * enough to offline-brute-force credentials. Stores the KDF parameters
 * alongside the hash so they can be tuned later without breaking existing
 * hashes. Returned string is what's stored in `user_account.auth_credential_ref`.
 */
export async function hashPassword(password: string, pepper: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(pepper + password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("hex"), derived.toString("hex")].join(
    "$",
  );
}

/**
 * Verifies a password against a stored hash produced by hashPassword (or
 * UNUSABLE_PASSWORD_HASH, which always fails). Uses a timing-safe comparison
 * so the final check can't leak information via response timing.
 */
export async function verifyPassword(
  password: string,
  pepper: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const [algo, nRaw, rRaw, pRaw, saltHex, hashHex] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (algo !== "scrypt") return false;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scryptAsync(pepper + password, salt, expected.length, { N: n, r, p });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
