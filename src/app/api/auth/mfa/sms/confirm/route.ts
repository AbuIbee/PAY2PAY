import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { getMfaService } from "@/lib/auth/getMfaService";
import type { MfaService } from "@/lib/auth/mfaService";
import { requireSession } from "@/lib/auth/requireSession";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const confirmSchema = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") });

// PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md): this route
// previously had no rate limiting at all, unlike its own enroll step — a 6-digit code has only
// 1,000,000 possibilities, so an unlimited number of guesses against one enrollment attempt is a
// genuine brute-force vector this PRSprint's scope exists to close.
const CONFIRM_LIMIT_PER_USER = 8;
const CONFIRM_WINDOW_MS = 15 * 60 * 1000;

export function createSmsConfirmHandler(authService: AuthService, mfaService: MfaService) {
  return async function handleConfirm(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = confirmSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A 6-digit code is required.");
    if (!(await checkRateLimit(`mfa-sms-confirm:user:${userId}`, CONFIRM_LIMIT_PER_USER, CONFIRM_WINDOW_MS))) {
      throw new RateLimitedError("Too many code attempts. Please request a new code and try again later.");
    }
    await mfaService.confirmSmsEnrollment(userId, parsed.data.code);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleConfirm(request: NextRequest): Promise<Response> {
  return createSmsConfirmHandler(getAuthService(), getMfaService())(request);
}

export const POST = withErrorHandling("auth_mfa_sms_confirm", handleConfirm);
