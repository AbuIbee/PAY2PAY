import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getMfaService } from "@/lib/auth/getMfaService";
import { ApprovalService } from "./approvalService";
import { DrizzleBusinessApprovalPolicyRepository } from "./drizzleBusinessApprovalPolicyRepository";
import { DrizzleStaffApprovalRequestRepository } from "./drizzleStaffApprovalRequestRepository";
import { getStaffService } from "./getStaffService";

let cached: ApprovalService | null = null;

/** Lazily creates (and memoizes) the production ApprovalService. Mirrors getAuthService.ts's pattern. */
export function getApprovalService(): ApprovalService {
  if (cached) return cached;
  cached = new ApprovalService(
    new DrizzleBusinessApprovalPolicyRepository(),
    new DrizzleStaffApprovalRequestRepository(),
    getStaffService(),
    getMfaService(),
    new AuditService(new DrizzleAuditEventRepository()),
  );
  return cached;
}
