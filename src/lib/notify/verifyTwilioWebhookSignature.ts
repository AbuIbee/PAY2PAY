import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * PRSprint 15, requirement #22/#46: Twilio's own webhook signature algorithm (distinct from Resend's
 * Svix-based scheme in verifyResendWebhookSignature.ts — the two providers do not share a convention,
 * matching that file's identical "separate function, not a reuse" precedent). Per Twilio's documented
 * algorithm: take the exact webhook URL Twilio was configured to call, append every POST parameter's
 * key immediately followed by its value (no separators) in ascending key order, HMAC-SHA1 the result
 * with `TWILIO_AUTH_TOKEN`, base64-encode, and compare against the `X-Twilio-Signature` header.
 *
 * The URL must be the *exact* URL Twilio requested — reconstructed here from the trusted, centralized
 * `APP_URL` (requirement #57: never a client-controlled Host header) plus the route's own known path,
 * never `request.url` verbatim (which on Vercel can reflect an internal/proxy host rather than the
 * public one Twilio actually signed against).
 */
export function verifyTwilioWebhookSignature(fullUrl: string, params: Record<string, string>, signatureHeader: string | null, authToken: string): boolean {
  if (!signatureHeader) return false;

  const sortedKeys = Object.keys(params).sort();
  let data = fullUrl;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");

  const expectedBuf = Buffer.from(expected, "base64");
  let actualBuf: Buffer;
  try {
    actualBuf = Buffer.from(signatureHeader, "base64");
  } catch {
    return false;
  }
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Parses an `application/x-www-form-urlencoded` request body into the flat string-keyed map Twilio's own signature algorithm expects. */
export function parseFormUrlEncoded(rawBody: string): Record<string, string> {
  const params: Record<string, string> = {};
  const search = new URLSearchParams(rawBody);
  for (const [key, value] of search.entries()) {
    params[key] = value;
  }
  return params;
}
