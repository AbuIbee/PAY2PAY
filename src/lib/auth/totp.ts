import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 (TOTP) / RFC 4226 (HOTP) implementation using only node:crypto —
 * deliberately no external authenticator-app library, since the algorithm
 * itself is small and well-specified; the risk with hand-rolled crypto is
 * usually in signature/attestation verification (which is why passkey/WebAuthn
 * was deferred instead of hand-rolled — see docs/AUTHENTICATION.md), not in
 * implementing a published HMAC-based OTP algorithm correctly against its
 * test vectors.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SECRET_BYTES = 20; // 160 bits, RFC 4226's recommended HOTP secret length
const TIME_STEP_SECONDS = 30;
const CODE_DIGITS = 6;

/** Exported for tests (encoding the RFC 6238 Appendix B ASCII test seed to base32). */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generates a new random base32-encoded TOTP secret. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** otpauth:// URI for an authenticator app to scan/import (as text — no QR image dependency added). */
export function buildTotpUri(secret: string, accountLabel: string, issuer = "PAY2PAY"): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(CODE_DIGITS),
    period: String(TIME_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function hotp(secret: Buffer, counter: bigint): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const b0 = hmac[offset] ?? 0;
  const b1 = hmac[offset + 1] ?? 0;
  const b2 = hmac[offset + 2] ?? 0;
  const b3 = hmac[offset + 3] ?? 0;
  const binary = ((b0 & 0x7f) << 24) | (b1 << 16) | (b2 << 8) | b3;
  return (binary % 10 ** CODE_DIGITS).toString().padStart(CODE_DIGITS, "0");
}

function currentTimeStep(now: number): bigint {
  return BigInt(Math.floor(now / 1000 / TIME_STEP_SECONDS));
}

/** Computes the current 6-digit code for a base32 secret. Exported mainly for tests. */
export function computeTotpCode(secretBase32: string, now: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), currentTimeStep(now));
}

/**
 * Verifies a 6-digit code against a base32 secret, tolerating +/-1 time step
 * (30s each way) for clock drift between server and authenticator app.
 * Timing-safe comparison so the check can't leak information via response
 * timing (mirrors password.ts's verifyPassword).
 */
export function verifyTotp(secretBase32: string, code: string, now: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const step = currentTimeStep(now);
  const codeBuffer = Buffer.from(code);
  for (const delta of [BigInt(0), BigInt(-1), BigInt(1)]) {
    const expected = Buffer.from(hotp(secret, step + delta));
    if (expected.length === codeBuffer.length && timingSafeEqual(expected, codeBuffer)) {
      return true;
    }
  }
  return false;
}
