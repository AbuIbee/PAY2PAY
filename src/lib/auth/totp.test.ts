import { describe, expect, it } from "vitest";
import { base32Encode, computeTotpCode, generateTotpSecret, verifyTotp } from "./totp";

// RFC 6238 Appendix B test vector (SHA1): 20-byte ASCII seed
// "12345678901234567890", T=59s -> time step 1 -> 8-digit code "94287082".
// Our implementation truncates to 6 digits (10^6), which is the last 6
// digits of the same dynamic-truncation value the RFC computes to 8 digits
// — this is a standard TOTP interoperability property (mod 10^8's last 6
// digits equal mod 10^6), so this confirms our HMAC/counter/truncation
// logic is bit-exact-correct against the published RFC vector, not just
// internally self-consistent — the thing that actually matters for
// interop with real authenticator apps (Google Authenticator, Authy, etc.).
const RFC_SEED_ASCII = "12345678901234567890";
const RFC_SEED_BASE32 = base32Encode(Buffer.from(RFC_SEED_ASCII, "ascii"));
const RFC_TIME_STEP_1_MS = 59 * 1000;
const RFC_EXPECTED_8_DIGIT = "94287082";

describe("totp", () => {
  it("matches the RFC 6238 Appendix B test vector (truncated to 6 digits)", () => {
    const code = computeTotpCode(RFC_SEED_BASE32, RFC_TIME_STEP_1_MS);
    expect(code).toBe(RFC_EXPECTED_8_DIGIT.slice(-6));
  });

  it("verifies a freshly computed code for a freshly generated secret", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = computeTotpCode(secret, now);
    expect(verifyTotp(secret, code, now)).toBe(true);
  });

  it("tolerates one time-step of clock drift in either direction", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = computeTotpCode(secret, now);
    expect(verifyTotp(secret, code, now + 30_000)).toBe(true);
    expect(verifyTotp(secret, code, now - 30_000)).toBe(true);
  });

  it("rejects a code more than one time-step away", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = computeTotpCode(secret, now);
    expect(verifyTotp(secret, code, now + 90_000)).toBe(false);
  });

  it("rejects a malformed code", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "abcdef")).toBe(false);
    expect(verifyTotp(secret, "12345")).toBe(false);
  });

  it("rejects a code from a different secret", () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const now = Date.now();
    const code = computeTotpCode(secretA, now);
    expect(verifyTotp(secretB, code, now)).toBe(false);
  });
});
