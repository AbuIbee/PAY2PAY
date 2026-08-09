import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { getMfaService } from "@/lib/auth/getMfaService";
import type { MfaService } from "@/lib/auth/mfaService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const initiateSchema = z.object({ method: z.enum(["totp", "sms"]) });

/**
 * For method="sms" this sends the code. For method="totp" this is a no-op
 * (the user reads the code from their already-enrolled authenticator app) —
 * still a valid call for a client to make uniformly before showing the
 * challenge UI, per MfaService.initiateStepUp's doc comment.
 */
export function createStepUpInitiateHandler(authService: AuthService, mfaService: MfaService) {
  return async function handleInitiate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = initiateSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid MFA method is required.");
    await mfaService.initiateStepUp(userId, parsed.data.method);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleInitiate(request: NextRequest): Promise<Response> {
  return createStepUpInitiateHandler(getAuthService(), getMfaService())(request);
}

export const POST = withErrorHandling("auth_mfa_step_up_initiate", handleInitiate);
