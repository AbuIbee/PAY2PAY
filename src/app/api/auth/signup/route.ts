import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { setSessionCookie } from "@/lib/auth/cookies";
import { getAuthService } from "@/lib/auth/getAuthService";
import { ValidationError, RateLimitedError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(256),
  // Age eligibility (18+) is enforced by AuthService.signup itself — this
  // regex only validates shape, not the age business rule.
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be in YYYY-MM-DD format."),
});

// NFR-SEC-004: authentication endpoints are rate-limited per account/IP/device.
const SIGNUP_LIMIT_PER_IP = 5;
const SIGNUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Factory so this route is testable against an in-memory AuthService
 * (see route.test.ts) without a live database — the exported POST handler
 * below wires in the real, Drizzle-backed getAuthService() lazily, only when
 * a request actually arrives (mirrors src/db/client.ts's lazy pattern).
 */
export function createSignupHandler(authService: AuthService) {
  return async function handleSignup(request: NextRequest): Promise<Response> {
    const ip = getClientIp(request);
    if (!(await checkRateLimit(`signup:ip:${ip}`, SIGNUP_LIMIT_PER_IP, SIGNUP_WINDOW_MS))) {
      throw new RateLimitedError("Too many signup attempts. Please try again later.");
    }

    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = signupSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(
        "A valid email, a password of at least 8 characters, and a date of birth are required.",
      );
    }

    const { user, token, expiresAt } = await authService.signup({
      email: parsed.data.email,
      password: parsed.data.password,
      dateOfBirth: parsed.data.dateOfBirth,
      ipAddress: ip,
      userAgent: request.headers.get("user-agent"),
    });

    const response = NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
    setSessionCookie(response, token, expiresAt);
    return response;
  };
}

async function handleSignup(request: NextRequest): Promise<Response> {
  return createSignupHandler(getAuthService())(request);
}

export const POST = withErrorHandling("auth_signup", handleSignup);
