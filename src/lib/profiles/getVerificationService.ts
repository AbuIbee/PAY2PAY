import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleEmailVerificationReader } from "./drizzleEmailVerificationReader";
import { DrizzleIdentityVerificationRecordRepository } from "./drizzleIdentityVerificationRecordRepository";
import { DrizzleProfileOwnerReader } from "./drizzleProfileOwnerReader";
import { VerificationService } from "./verificationService";

let cached: VerificationService | null = null;

export function getVerificationService(): VerificationService {
  if (!cached) {
    cached = new VerificationService(
      new DrizzleIdentityVerificationRecordRepository(),
      new DrizzleEmailVerificationReader(),
      new DrizzleProfileOwnerReader(),
      new AuditService(new DrizzleAuditEventRepository()),
    );
  }
  return cached;
}
