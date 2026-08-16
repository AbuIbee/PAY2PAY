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

const requestSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

const RESET_LIMIT_PER_IP = 10;
const RESET_LIMIT_PER_EMAIL = 5;
const RESET_WINDOW_MS = 15 * 60 * 1000;

export function createPasswordResetRequestHandler(authService: AuthService) {
  return async function handleRequest(request: NextRequest): Promise<Response> {
    const ip = getClientIp(request);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("A valid email is required.");
    }
    if (!(await checkRateLimit(`password-reset:ip:${ip}`, RESET_LIMIT_PER_IP, RESET_WINDOW_MS))) {
      throw new RateLimitedError();
    }
    if (!(await checkRateLimit(`password-reset:email:${parsed.data.email}`, RESET_LIMIT_PER_EMAIL, RESET_WINDOW_MS))) {
      throw new RateLimitedError();
    }

    await authService.requestPasswordReset(parsed.data.email, { ipAddress: ip, userAgent: request.headers.get("user-agent") });
    // Always the same response, regardless of whether the email exists —
    // see AuthService.requestPasswordReset's doc comment (enumeration resistance).
    return NextResponse.json(
      { status: "ok", message: "If that email has an account, a reset link has been sent." },
      { status: 200 },
    );
  };
}

async function handleRequest(request: NextRequest): Promise<Response> {
  return createPasswordResetRequestHandler(getAuthService())(request);
}

export const POST = withErrorHandling("auth_password_reset_request", handleRequest);
