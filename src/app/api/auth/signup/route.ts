import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { setSessionCookie } from "@/lib/auth/cookies";
import { getAuthService } from "@/lib/auth/getAuthService";
import type { BetaInviteService } from "@/lib/compliance/betaInviteService";
import { getBetaInviteService } from "@/lib/compliance/getBetaInviteService";
import { ValidationError, RateLimitedError } from "@/lib/errors";
import { isFeatureEnabled } from "@/lib/feature-flags";
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
  // PRSprint 33: only required/checked when closedBetaEnabled is on — see BetaInviteService's doc
  // comment for why this gate lives here rather than inside AuthService.signup.
  inviteCode: z.string().trim().optional(),
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
export function createSignupHandler(authService: AuthService, betaInvites: BetaInviteService) {
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

    // PRSprint 33 (docs/prsprints/PRSPRINT_33_FINAL_PRODUCTION_LAUNCH_CONTROLS_CLOSED_BETA.md): a
    // pre-check, before AuthService.signup is ever called — an invalid/missing code during closed
    // beta means no account is created at all. See BetaInviteService's own doc comment for why the
    // actual atomic consumption happens as a separate step after signup, not here.
    const closedBeta = isFeatureEnabled("closedBetaEnabled");
    if (closedBeta) {
      await betaInvites.checkCodeIsRedeemable(parsed.data.inviteCode ?? "");
    }

    const { user, token, expiresAt } = await authService.signup({
      email: parsed.data.email,
      password: parsed.data.password,
      dateOfBirth: parsed.data.dateOfBirth,
      ipAddress: ip,
      userAgent: request.headers.get("user-agent"),
    });

    if (closedBeta && parsed.data.inviteCode) {
      await betaInvites.consumeCode(parsed.data.inviteCode, user.id);
    }

    const response = NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
    setSessionCookie(response, token, expiresAt);
    return response;
  };
}

async function handleSignup(request: NextRequest): Promise<Response> {
  return createSignupHandler(getAuthService(), getBetaInviteService())(request);
}

export const POST = withErrorHandling("auth_signup", handleSignup);
