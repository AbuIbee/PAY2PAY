/**
 * In-memory fixed-window rate limiter (NFR-SEC-004: authentication endpoints
 * are rate-limited per account/IP/device). Deliberately dependency-free for
 * Phase 0, matching src/lib/logger.ts's philosophy — swap for a shared store
 * (e.g. Redis) once the app runs on more than one instance, since an
 * in-memory map only limits requests hitting the same process.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Returns true if `key` is still within `limit` requests per `windowMs`,
 * and records this call toward that limit. Returns false once the limit is
 * exceeded for the remainder of the current window.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** Test-only escape hatch so each test starts with a clean rate-limit state. */
export function resetRateLimits(): void {
  buckets.clear();
}
