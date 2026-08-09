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

const verifySchema = z.object({
  method: z.enum(["totp", "sms"]),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
  // Free-text label of the sensitive action being gated (e.g.
  // "sign_agreement") — used for audit only, does not affect pass/fail.
  action: z.string().min(1).max(100),
});

const STEP_UP_LIMIT_PER_SESSION = 10;
const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

export function createStepUpVerifyHandler(authService: AuthService, mfaService: MfaService) {
  return async function handleVerify(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    if (!checkRateLimit(`mfa-step-up:session:${sessionId}`, STEP_UP_LIMIT_PER_SESSION, STEP_UP_WINDOW_MS)) {
      throw new RateLimitedError();
    }
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = verifySchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid MFA method, 6-digit code, and action are required.");

    const passed = await mfaService.completeStepUp({
      userId,
      sessionId,
      method: parsed.data.method,
      code: parsed.data.code,
      action: parsed.data.action,
    });
    return NextResponse.json({ passed }, { status: passed ? 200 : 401 });
  };
}

async function handleVerify(request: NextRequest): Promise<Response> {
  return createStepUpVerifyHandler(getAuthService(), getMfaService())(request);
}

export const POST = withErrorHandling("auth_mfa_step_up_verify", handleVerify);
