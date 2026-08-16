import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { setSessionCookie } from "@/lib/auth/cookies";
import { getAuthService } from "@/lib/auth/getAuthService";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});

// NFR-SEC-004: rate-limited per IP *and* per account, so this resists both a
// distributed credential-stuffing sweep and a focused attack on one email.
const LOGIN_LIMIT_PER_IP = 10;
const LOGIN_LIMIT_PER_EMAIL = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function createLoginHandler(authService: AuthService) {
  return async function handleLogin(request: NextRequest): Promise<Response> {
    const ip = getClientIp(request);

    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = loginSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("A valid email and password are required.");
    }

    if (!(await checkRateLimit(`login:ip:${ip}`, LOGIN_LIMIT_PER_IP, LOGIN_WINDOW_MS))) {
      throw new RateLimitedError("Too many login attempts. Please try again later.");
    }
    if (
      !(await checkRateLimit(`login:email:${parsed.data.email}`, LOGIN_LIMIT_PER_EMAIL, LOGIN_WINDOW_MS))
    ) {
      throw new RateLimitedError("Too many login attempts. Please try again later.");
    }

    const { user, token, expiresAt } = await authService.login({
      email: parsed.data.email,
      password: parsed.data.password,
      ipAddress: ip,
      userAgent: request.headers.get("user-agent"),
    });

    const response = NextResponse.json({ id: user.id, email: user.email }, { status: 200 });
    setSessionCookie(response, token, expiresAt);
    return response;
  };
}

async function handleLogin(request: NextRequest): Promise<Response> {
  return createLoginHandler(getAuthService())(request);
}

export const POST = withErrorHandling("auth_login", handleLogin);
