import "server-only";
import { DrizzleEarlyAccessLeadRepository } from "./drizzleEarlyAccessLeadRepository";
import type { EarlyAccessLeadRepository } from "./earlyAccessLeadRepository";

let cached: EarlyAccessLeadRepository | null = null;

/**
 * Lazily creates (and memoizes) the production repository. Mirrors
 * src/lib/auth/getAuthService.ts's pattern — nothing calls this at
 * module-load time, so the landing page itself never requires DATABASE_URL.
 */
export function getEarlyAccessLeadRepository(): EarlyAccessLeadRepository {
  if (!cached) {
    cached = new DrizzleEarlyAccessLeadRepository();
  }
  return cached;
}
