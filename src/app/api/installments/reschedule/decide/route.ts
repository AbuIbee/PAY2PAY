import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getRescheduleRequestService } from "@/lib/failedPayments/getRescheduleRequestService";
import type { RescheduleRequestService } from "@/lib/failedPayments/rescheduleRequestService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decideSchema = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  decisionReason: z.string().trim().min(1).max(2000).nullable().default(null),
});

export function createRescheduleDecideHandler(authService: AuthService, rescheduleRequestService: RescheduleRequestService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = decideSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid reschedule decision is required.");
    }
    const record = await rescheduleRequestService.decideReschedule({
      requestId: parsed.data.requestId,
      decision: parsed.data.decision,
      decisionReason: parsed.data.decisionReason,
      actingUserId: userId,
    });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createRescheduleDecideHandler(getAuthService(), getRescheduleRequestService())(request);
}

export const POST = withErrorHandling("installment_reschedule_decide", handlePost);
