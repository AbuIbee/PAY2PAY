import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { ConsoleSmsSender } from "@/lib/notify/consoleSmsSender";
import { DrizzleMfaChallengeRepository } from "./drizzleMfaChallengeRepository";
import { DrizzleMfaCredentialRepository } from "./drizzleMfaCredentialRepository";
import { DrizzleStepUpVerificationRepository } from "./drizzleStepUpVerificationRepository";
import { MfaService } from "./mfaService";

let cached: MfaService | null = null;

/** Lazily creates (and memoizes) the production MfaService. Mirrors getAuthService.ts's pattern. */
export function getMfaService(): MfaService {
  if (!cached) {
    cached = new MfaService(
      new DrizzleMfaCredentialRepository(),
      new DrizzleMfaChallengeRepository(),
      new DrizzleStepUpVerificationRepository(),
      new AuditService(new DrizzleAuditEventRepository()),
      new ConsoleSmsSender(),
    );
  }
  return cached;
}
