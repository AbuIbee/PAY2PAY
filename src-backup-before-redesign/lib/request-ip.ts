import type { NextRequest } from "next/server";

/**
 * Best-effort client IP for rate-limiting/audit purposes. Next.js's
 * `NextRequest` no longer exposes `.ip` directly — the platform/proxy in
 * front of the app is expected to set `x-forwarded-for`. Falls back to
 * "unknown" rather than throwing, since this is only used for rate-limit
 * bucketing and audit metadata, never for security decisions that require a
 * trustworthy IP.
 */
export function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const first = forwardedFor?.split(",")[0]?.trim();
  return first || "unknown";
}
