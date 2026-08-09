import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const confirmSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(256),
});

const CONFIRM_LIMIT_PER_IP = 20;
const CONFIRM_WINDOW_MS = 15 * 60 * 1000;

export function createPasswordResetConfirmHandler(authService: AuthService) {
  return async function handleConfirm(request: NextRequest): Promise<Response> {
    const ip = getClientIp(request);
    if (!checkRateLimit(`password-reset-confirm:ip:${ip}`, CONFIRM_LIMIT_PER_IP, CONFIRM_WINDOW_MS)) {
      throw new RateLimitedError();
    }
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = confirmSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("A valid token and a password of at least 8 characters are required.");
    }
    await authService.resetPassword(parsed.data.token, parsed.data.password);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleConfirm(request: NextRequest): Promise<Response> {
  return createPasswordResetConfirmHandler(getAuthService())(request);
}

export const POST = withErrorHandling("auth_password_reset_confirm", handleConfirm);
