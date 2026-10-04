import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { BusinessVerificationService } from "./businessVerificationService";
import { DrizzleBusinessVerificationRepository } from "./drizzleBusinessVerificationRepository";
import { getBusinessVerificationProvider } from "./getBusinessVerificationProvider";

let cached: BusinessVerificationService | null = null;

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 9: `getBusinessVerificationProvider()` throws
 * `ProviderNotAvailableError` today (no provider registered) — callers (BusinessOnboardingService)
 * let that propagate; this factory does not catch it, matching getPaymentProvider.ts/
 * getKycProvider.ts's own established "construct lazily, fail closed at the point of use" pattern.
 */
export function getBusinessVerificationService(): BusinessVerificationService {
  if (!cached) {
    cached = new BusinessVerificationService(getBusinessVerificationProvider(), new DrizzleBusinessVerificationRepository(), new AuditService(new DrizzleAuditEventRepository()));
  }
  return cached;
}
