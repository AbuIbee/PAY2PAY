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

const requestSchema = z.object({
  installmentScheduleItemId: z.string().uuid(),
  agreementId: z.string().uuid(),
  requestedDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "requestedDueDate must be in YYYY-MM-DD format."),
  reason: z.string().trim().min(1).max(2000).nullable().default(null),
});

export function createRescheduleRequestHandler(authService: AuthService, rescheduleRequestService: RescheduleRequestService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid reschedule request is required.");
    }
    const record = await rescheduleRequestService.requestReschedule({
      installmentScheduleItemId: parsed.data.installmentScheduleItemId,
      agreementId: parsed.data.agreementId,
      requestedDueDate: parsed.data.requestedDueDate,
      reason: parsed.data.reason,
      actingUserId: userId,
    });
    return NextResponse.json(record, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createRescheduleRequestHandler(getAuthService(), getRescheduleRequestService())(request);
}

export const POST = withErrorHandling("installment_reschedule_request", handlePost);
