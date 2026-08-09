import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { ApprovalService } from "@/lib/staff/approvalService";
import { ValidationError } from "@/lib/errors";
import { getApprovalService } from "@/lib/staff/getApprovalService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decideSchema = z.object({
  businessProfileId: z.string().uuid(),
  requestId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
});

/** No-self-approval and owner-required are both enforced in ApprovalService.decideAction. */
export function createApprovalRequestDecideHandler(authService: AuthService, approvalService: ApprovalService) {
  return async function handleDecide(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = decideSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid decision is required.");
    }

    const decided = await approvalService.decideAction({
      businessProfileId: parsed.data.businessProfileId,
      decidingUserId: userId,
      requestId: parsed.data.requestId,
      decision: parsed.data.decision,
    });
    return NextResponse.json({ id: decided.id, status: decided.status }, { status: 200 });
  };
}

async function handleDecide(request: NextRequest): Promise<Response> {
  return createApprovalRequestDecideHandler(getAuthService(), getApprovalService())(request);
}

export const POST = withErrorHandling("staff_approval_request_decide", handleDecide);
