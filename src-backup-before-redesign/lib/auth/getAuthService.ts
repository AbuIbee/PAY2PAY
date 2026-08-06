import "server-only";
import { getServerEnv } from "@/config/env";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { AuthService } from "./authService";
import { DrizzleSessionRepository } from "./drizzleSessionRepository";
import { DrizzleUserAccountRepository } from "./drizzleUserAccountRepository";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let cached: AuthService | null = null;

/**
 * Lazily creates (and memoizes) the production AuthService, wired to the
 * real Drizzle-backed repositories. Mirrors src/db/client.ts's
 * lazy-singleton pattern — nothing calls this at module-load time, so
 * routes that don't need auth (or the build/collection phase itself) never
 * require DATABASE_URL/AUTH_PASSWORD_PEPPER to be configured.
 */
export function getAuthService(): AuthService {
  if (cached) return cached;
  const { AUTH_PASSWORD_PEPPER } = getServerEnv();
  cached = new AuthService(
    new DrizzleUserAccountRepository(),
    new DrizzleSessionRepository(),
    new AuditService(new DrizzleAuditEventRepository()),
    { pepper: AUTH_PASSWORD_PEPPER, sessionTtlMs: SESSION_TTL_MS },
  );
  return cached;
}
