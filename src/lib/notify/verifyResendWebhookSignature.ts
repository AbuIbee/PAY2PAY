import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * PRSprint 14, requirement #27: Resend signs delivery webhooks using the Svix convention (distinct
 * from this codebase's own sandbox-provider HMAC format in src/lib/webhookSignature.ts, which is why
 * this is a separate function rather than a reuse of `verifyHmacSignature` — the two providers do not
 * share an algorithm). Signed content is `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256'd with
 * the base64 payload of a `whsec_...`-prefixed secret, base64-encoded, and compared against one or
 * more `v1,<sig>` entries in the `svix-signature` header (space-separated — Svix rotates signing
 * secrets by briefly signing with both the old and new key). A timestamp outside a five-minute
 * tolerance is rejected regardless of signature validity — replay protection for a captured, otherwise
 * still-computable-if-the-secret-leaked request.
 */
const TOLERANCE_SECONDS = 5 * 60;

export interface ResendWebhookHeaders {
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
}

export function verifyResendWebhookSignature(rawBody: string, headers: ResendWebhookHeaders, secret: string, now: Date = new Date()): boolean {
  const { svixId, svixTimestamp, svixSignature } = headers;
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const timestampSeconds = Number(svixTimestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const skewSeconds = Math.abs(now.getTime() / 1000 - timestampSeconds);
  if (skewSeconds > TOLERANCE_SECONDS) return false;

  const secretBytes = decodeSecret(secret);
  if (!secretBytes) return false;

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes).update(signedContent).digest();

  for (const candidate of svixSignature.split(" ")) {
    const [version, sigBase64] = candidate.split(",", 2);
    if (version !== "v1" || !sigBase64) continue;
    let actual: Buffer;
    try {
      actual = Buffer.from(sigBase64, "base64");
    } catch {
      continue;
    }
    if (actual.length === expected.length && timingSafeEqual(expected, actual)) return true;
  }
  return false;
}

function decodeSecret(secret: string): Buffer | null {
  const withoutPrefix = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  try {
    return Buffer.from(withoutPrefix, "base64");
  } catch {
    return null;
  }
}
