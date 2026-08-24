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

const disableSchema = z.object({ method: z.enum(["totp", "sms"]) });

export function createMfaDisableHandler(authService: AuthService, mfaService: MfaService) {
  return async function handleDisable(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = disableSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A valid MFA method is required.");
    await mfaService.disableMethod(userId, sessionId, parsed.data.method);
    return NextResponse.json({ status: "disabled" }, { status: 200 });
  };
}

async function handleDisable(request: NextRequest): Promise<Response> {
  return createMfaDisableHandler(getAuthService(), getMfaService())(request);
}

export const POST = withErrorHandling("auth_mfa_disable", handleDisable);
