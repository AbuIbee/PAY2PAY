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

const verifyEmailSchema = z.object({ token: z.string().min(1) });

const VERIFY_LIMIT_PER_IP = 20;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;

export function createVerifyEmailHandler(authService: AuthService) {
  return async function handleVerifyEmail(request: NextRequest): Promise<Response> {
    const ip = getClientIp(request);
    if (!(await checkRateLimit(`verify-email:ip:${ip}`, VERIFY_LIMIT_PER_IP, VERIFY_WINDOW_MS))) {
      throw new RateLimitedError();
    }
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = verifyEmailSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("A verification token is required.");
    }
    await authService.verifyEmail(parsed.data.token);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleVerifyEmail(request: NextRequest): Promise<Response> {
  return createVerifyEmailHandler(getAuthService())(request);
}

export const POST = withErrorHandling("auth_verify_email", handleVerifyEmail);
