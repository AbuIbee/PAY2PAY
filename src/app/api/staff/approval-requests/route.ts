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

const proposeSchema = z.object({
  businessProfileId: z.string().uuid(),
  actionType: z.enum(CAPABILITIES),
  amountMinorUnits: z.number().int().nonnegative().nullable().optional(),
  relatedAgreementId: z.string().uuid().nullable().optional(),
  actionPayload: z.unknown(),
});

/**
 * Proposes a capability-gated action (e.g. approve_settlement,
 * forgive_principal). See ApprovalService.proposeAction — if no policy
 * applies, requiresApproval is false and the caller executes the action
 * immediately; otherwise a pending staff_approval_request is created and
 * must go through /api/staff/approval-requests/decide.
 */
export function createApprovalRequestProposeHandler(authService: AuthService, approvalService: ApprovalService) {
  return async function handlePropose(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = proposeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid proposal is required.");
    }

    const outcome = await approvalService.proposeAction({
      businessProfileId: parsed.data.businessProfileId,
      proposedByUserId: userId,
      actionType: parsed.data.actionType,
      amountMinorUnits: parsed.data.amountMinorUnits ?? null,
      relatedAgreementId: parsed.data.relatedAgreementId ?? null,
      actionPayload: parsed.data.actionPayload ?? null,
    });
    return NextResponse.json(
      {
        requiresApproval: outcome.requiresApproval,
        request: outcome.request
          ? {
              id: outcome.request.id,
              status: outcome.request.status,
              reasonFlagged: outcome.request.reasonFlagged,
            }
          : null,
      },
      { status: 200 },
    );
  };
}

/** The pending-approval queue for a business — see ApprovalService.listPendingRequests. */
export function createApprovalRequestListHandler(authService: AuthService, staffService: StaffService, approvalService: ApprovalService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const businessProfileId = new URL(request.url).searchParams.get("businessProfileId");
    if (!businessProfileId) throw new ValidationError("businessProfileId is required.");
    await staffService.requireActiveStaff(businessProfileId, userId);

    const requests = await approvalService.listPendingRequests(businessProfileId);
    return NextResponse.json(
      {
        requests: requests.map((r) => ({
          id: r.id,
          proposedByStaffId: r.proposedByStaffId,
          relatedAgreementId: r.relatedAgreementId,
          actionType: r.actionType,
          reasonFlagged: r.reasonFlagged,
          status: r.status,
          createdAt: r.createdAt,
        })),
      },
      { status: 200 },
    );
  };
}

async function handlePropose(request: NextRequest): Promise<Response> {
  return createApprovalRequestProposeHandler(getAuthService(), getApprovalService())(request);
}

async function handleList(request: NextRequest): Promise<Response> {
  return createApprovalRequestListHandler(getAuthService(), getStaffService(), getApprovalService())(request);
}

export const POST = withErrorHandling("staff_approval_request_propose", handlePropose);
export const GET = withErrorHandling("staff_approval_request_list", handleList);
