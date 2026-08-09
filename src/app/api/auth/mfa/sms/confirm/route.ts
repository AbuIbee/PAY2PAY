import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { getMfaService } from "@/lib/auth/getMfaService";
import type { MfaService } from "@/lib/auth/mfaService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const confirmSchema = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") });

export function createSmsConfirmHandler(authService: AuthService, mfaService: MfaService) {
  return async function handleConfirm(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = confirmSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A 6-digit code is required.");
    await mfaService.confirmSmsEnrollment(userId, parsed.data.code);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleConfirm(request: NextRequest): Promise<Response> {
  return createSmsConfirmHandler(getAuthService(), getMfaService())(request);
}

export const POST = withErrorHandling("auth_mfa_sms_confirm", handleConfirm);
