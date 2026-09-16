import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getServerEnv } from "@/config/env";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { getBankConnectionService } from "@/lib/relationships/getBankConnectionService";
import type { BankConnectionService } from "@/lib/relationships/bankConnectionService";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PAID2YOU — B0-D ADYEN PHASE 2: mirrors the prior bank/connect route's own rate limit — this is now
// the route where a bank-tokenization session is actually created, the natural successor to "a raw
// routing/account number transits this route."
const BANK_SESSION_LIMIT_PER_USER = 5;
const BANK_SESSION_WINDOW_MS = 60 * 60 * 1000;

const sessionSchema = z.object({
  actingParty: z.object({ kind: z.enum(["personal", "business"]), id: z.string().uuid() }),
  institutionDisplayName: z.string().trim().max(200).nullable().optional(),
});

export function createBankSessionHandler(authService: AuthService, bankConnectionService: BankConnectionService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = sessionSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid bank-session request is required.");
    }
    if (!(await checkRateLimit(`bank-session:user:${userId}`, BANK_SESSION_LIMIT_PER_USER, BANK_SESSION_WINDOW_MS))) {
      throw new RateLimitedError("Too many bank connection attempts. Please try again later.");
    }
    const env = getServerEnv();
    const session = await bankConnectionService.initiateBankConnection({
      actingUserId: userId,
      actingSessionId: sessionId,
      actingParty: { kind: parsed.data.actingParty.kind, id: parsed.data.actingParty.id },
      returnUrl: `${env.APP_URL}/payment-methods/add-bank`,
      institutionDisplayName: parsed.data.institutionDisplayName ?? null,
    });
    return NextResponse.json(session, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createBankSessionHandler(getAuthService(), getBankConnectionService())(request);
}

export const POST = withErrorHandling("relationship_account_bank_session", handlePost);
