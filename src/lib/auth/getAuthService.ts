import "server-only";
import { getServerEnv } from "@/config/env";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getEmailSender } from "@/lib/notify/getEmailSender";
import { AuthService } from "./authService";
import { DrizzleAccountProvisioningRepository } from "./drizzleAccountProvisioningRepository";
import { DrizzleEmailVerificationTokenRepository } from "./drizzleEmailVerificationTokenRepository";
import { DrizzlePasswordResetTokenRepository } from "./drizzlePasswordResetTokenRepository";
import { DrizzlePreferredEmailSyncTarget } from "./drizzlePreferredEmailSyncTarget";
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
 * The email sender comes from getEmailSender() (PRSprint 14,
 * docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md) — real delivery once RESEND_API_KEY is configured,
 * ConsoleEmailSender (log-only) otherwise. AuthService's own verification/password-reset link
 * generation, token lifecycle, and session logic are entirely unchanged by this swap.
 */
export function getAuthService(): AuthService {
  if (cached) return cached;
  const { AUTH_PASSWORD_PEPPER, APP_URL } = getServerEnv();
  cached = new AuthService(
    new DrizzleUserAccountRepository(),
    new DrizzleSessionRepository(),
    new DrizzleAccountProvisioningRepository(),
    new DrizzleEmailVerificationTokenRepository(),
    new DrizzlePasswordResetTokenRepository(),
    new AuditService(new DrizzleAuditEventRepository()),
    getEmailSender(),
    { pepper: AUTH_PASSWORD_PEPPER, sessionTtlMs: SESSION_TTL_MS, appUrl: APP_URL },
    new DrizzlePreferredEmailSyncTarget(),
  );
  return cached;
}
