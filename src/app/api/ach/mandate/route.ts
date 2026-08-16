import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { getAchMandateService } from "@/lib/ach/getAchMandateService";
import type { AchMandateService } from "@/lib/ach/achMandateService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md): previously
// unprotected — bounds unbounded bank-account-linking attempts per account.
const MANDATE_AUTHORIZE_LIMIT_PER_USER = 10;
const MANDATE_AUTHORIZE_WINDOW_MS = 60 * 60 * 1000;

const authorizeSchema = z.object({
  agreementId: z.string().uuid(),
  payerProfileKind: z.enum(["personal", "business"]),
  payerProfileId: z.string().uuid(),
  bankAccountRef: z.string().trim().min(1).max(500),
});

export function createAchMandateAuthorizeHandler(authService: AuthService, achMandateService: AchMandateService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = authorizeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid mandate request is required.");
    }
    if (!(await checkRateLimit(`ach-mandate-authorize:user:${userId}`, MANDATE_AUTHORIZE_LIMIT_PER_USER, MANDATE_AUTHORIZE_WINDOW_MS))) {
      throw new RateLimitedError("Too many bank-linking attempts. Please try again later.");
    }
    const mandate = await achMandateService.authorize({
      agreementId: parsed.data.agreementId,
      payer: { profileKind: parsed.data.payerProfileKind, profileId: parsed.data.payerProfileId },
      bankAccountRef: parsed.data.bankAccountRef,
      actingUserId: userId,
    });
    return NextResponse.json(mandate, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAchMandateAuthorizeHandler(getAuthService(), getAchMandateService())(request);
}

export const POST = withErrorHandling("ach_mandate_authorize", handlePost);
