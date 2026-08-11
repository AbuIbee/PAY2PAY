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

const profileRefSchema = z.object({ profileKind: z.enum(["personal", "business"]), profileId: z.string().uuid() });

const manualSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  agreementId: z.string().uuid(),
  payer: profileRefSchema,
  recipient: profileRefSchema,
  amountMinorUnits: z.number().int().positive(),
  currency: z.string().trim().length(3).default("USD"),
});

export function createAchManualPaymentHandler(authService: AuthService, achPaymentService: AchPaymentService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = manualSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid manual payment request is required.");
    }
    const record = await achPaymentService.createManualPayment({ ...parsed.data, actingUserId: userId });
    return NextResponse.json({ id: record.id, status: record.status }, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAchManualPaymentHandler(getAuthService(), getAchPaymentService())(request);
}

export const POST = withErrorHandling("ach_payment_manual", handlePost);
