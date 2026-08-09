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

// E.164-ish: "+" followed by 8-15 digits.
const enrollSchema = z.object({ phoneNumber: z.string().regex(/^\+\d{8,15}$/, "Enter a valid phone number, e.g. +15551234567.") });

const SMS_ENROLL_LIMIT_PER_USER = 5;
const SMS_ENROLL_WINDOW_MS = 60 * 60 * 1000;

export function createSmsEnrollHandler(authService: AuthService, mfaService: MfaService) {
  return async function handleEnroll(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    if (!checkRateLimit(`mfa-sms-enroll:user:${userId}`, SMS_ENROLL_LIMIT_PER_USER, SMS_ENROLL_WINDOW_MS)) {
      throw new RateLimitedError();
    }
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = enrollSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid phone number is required.");
    await mfaService.beginSmsEnrollment(userId, parsed.data.phoneNumber);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleEnroll(request: NextRequest): Promise<Response> {
  return createSmsEnrollHandler(getAuthService(), getMfaService())(request);
}

export const POST = withErrorHandling("auth_mfa_sms_enroll", handleEnroll);
