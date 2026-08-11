import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shared HMAC-SHA256 webhook signing/verification helper, used by both Sprint 9 sandbox providers
 * (payment and KYC/KYB — src/lib/payments/sandboxPaymentProvider.ts,
 * src/lib/kyc/sandboxKycProvider.ts). This is pure, provider-agnostic cryptography, not a merge of
 * the two domain interfaces (which stay deliberately separate per this sprint's text) — extracting
 * it avoids duplicating the same signing math in two places.
 */
export function computeHmacSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyHmacSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  const expectedBuf = Buffer.from(computeHmacSignature(rawBody, secret), "hex");
  const actualBuf = Buffer.from(signatureHeader, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
