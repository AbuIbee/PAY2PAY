import "server-only";
import { getServerEnv } from "@/config/env";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { ConsoleEmailSender } from "@/lib/notify/consoleEmailSender";
import { AuthService } from "./authService";
import { DrizzleEmailVerificationTokenRepository } from "./drizzleEmailVerificationTokenRepository";
import { DrizzlePasswordResetTokenRepository } from "./drizzlePasswordResetTokenRepository";
import { DrizzlePersonalProfileRepository } from "./drizzlePersonalProfileRepository";
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
 *
 * ConsoleEmailSender is a deliberate placeholder — see its doc comment and
 * docs/AUTHENTICATION.md: no real email provider is integrated yet.
 */
export function getAuthService(): AuthService {
  if (cached) return cached;
  const { AUTH_PASSWORD_PEPPER, APP_URL } = getServerEnv();
  cached = new AuthService(
    new DrizzleUserAccountRepository(),
    new DrizzleSessionRepository(),
    new DrizzlePersonalProfileRepository(),
    new DrizzleEmailVerificationTokenRepository(),
    new DrizzlePasswordResetTokenRepository(),
    new AuditService(new DrizzleAuditEventRepository()),
    new ConsoleEmailSender(),
    { pepper: AUTH_PASSWORD_PEPPER, sessionTtlMs: SESSION_TTL_MS, appUrl: APP_URL },
  );
  return cached;
}
