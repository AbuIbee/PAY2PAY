import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { ApprovalService } from "@/lib/staff/approvalService";
import { CAPABILITIES } from "@/lib/staff/capabilities";
import { ValidationError } from "@/lib/errors";
import { getApprovalService } from "@/lib/staff/getApprovalService";
import { getStaffService } from "@/lib/staff/getStaffService";
import type { StaffService } from "@/lib/staff/staffService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const setPolicySchema = z.object({
  businessProfileId: z.string().uuid(),
  capability: z.enum(CAPABILITIES),
  thresholdMinorUnits: z.number().int().nonnegative().nullable(),
  requiresDualApproval: z.boolean(),
  requiresOwner: z.boolean(),
});

/**
 * Settlement/balance-adjustment approval limits, two-person approval, and
 * owner-required thresholds — see ApprovalService.setApprovalPolicy.
 * Threshold changes always require a fresh step-up.
 */
export function createApprovalPolicySetHandler(authService: AuthService, approvalService: ApprovalService) {
  return async function handleSet(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = setPolicySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid approval policy is required.");
    }

    const policy = await approvalService.setApprovalPolicy({
      businessProfileId: parsed.data.businessProfileId,
      actingUserId: userId,
      actingSessionId: sessionId,
      capability: parsed.data.capability,
      thresholdMinorUnits: parsed.data.thresholdMinorUnits,
      requiresDualApproval: parsed.data.requiresDualApproval,
      requiresOwner: parsed.data.requiresOwner,
    });
    return NextResponse.json(
      {
        capability: policy.capability,
        thresholdMinorUnits: policy.thresholdMinorUnits,
        requiresDualApproval: policy.requiresDualApproval,
        requiresOwner: policy.requiresOwner,
      },
      { status: 200 },
    );
  };
}

export function createApprovalPolicyListHandler(authService: AuthService, staffService: StaffService, approvalService: ApprovalService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const businessProfileId = new URL(request.url).searchParams.get("businessProfileId");
    if (!businessProfileId) throw new ValidationError("businessProfileId is required.");
    await staffService.requireActiveStaff(businessProfileId, userId);

    const policies = await approvalService.listPolicies(businessProfileId);
    return NextResponse.json(
      {
        policies: policies.map((p) => ({
          capability: p.capability,
          thresholdMinorUnits: p.thresholdMinorUnits,
          requiresDualApproval: p.requiresDualApproval,
          requiresOwner: p.requiresOwner,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleSet(request: NextRequest): Promise<Response> {
  return createApprovalPolicySetHandler(getAuthService(), getApprovalService())(request);
}

async function handleList(request: NextRequest): Promise<Response> {
  return createApprovalPolicyListHandler(getAuthService(), getStaffService(), getApprovalService())(request);
}

export const POST = withErrorHandling("staff_approval_policy_set", handleSet);
export const GET = withErrorHandling("staff_approval_policy_list", handleList);
