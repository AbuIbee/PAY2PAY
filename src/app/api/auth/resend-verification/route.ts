import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { RateLimitedError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Authenticated resend — no email-lookup surface, so no enumeration risk;
// still rate-limited per account to bound email volume.
const RESEND_LIMIT_PER_USER = 5;
const RESEND_WINDOW_MS = 60 * 60 * 1000;

export function createResendVerificationHandler(authService: AuthService) {
  return async function handleResend(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    if (!(await checkRateLimit(`resend-verification:user:${userId}`, RESEND_LIMIT_PER_USER, RESEND_WINDOW_MS))) {
      throw new RateLimitedError();
    }
    await authService.resendVerificationEmail(userId);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleResend(request: NextRequest): Promise<Response> {
  return createResendVerificationHandler(getAuthService())(request);
}

export const POST = withErrorHandling("auth_resend_verification", handleResend);
