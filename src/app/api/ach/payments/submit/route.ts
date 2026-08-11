import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { getAchPaymentService } from "@/lib/ach/getAchPaymentService";
import type { AchPaymentService } from "@/lib/ach/achPaymentService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const submitSchema = z.object({ id: z.string().uuid() });

export function createAchSubmitHandler(authService: AuthService, achPaymentService: AchPaymentService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = submitSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid submit request is required.");
    }
    const record = await achPaymentService.submitScheduledPayment(parsed.data.id, userId);
    return NextResponse.json({ id: record.id, status: record.status }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAchSubmitHandler(getAuthService(), getAchPaymentService())(request);
}

export const POST = withErrorHandling("ach_payment_submit", handlePost);
