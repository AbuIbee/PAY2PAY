import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { getBankConnectionService } from "@/lib/relationships/getBankConnectionService";
import type { BankConnectionService } from "@/lib/relationships/bankConnectionService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bounds unbounded bank-connection attempts, mirroring PRSprint 24's identical card-request
// precedent — a raw routing/account number transits this route (the documented fallback
// architecture), so it is also, deliberately, the more tightly rate-limited of the two.
const BANK_CONNECT_LIMIT_PER_USER = 5;
const BANK_CONNECT_WINDOW_MS = 60 * 60 * 1000;

const connectSchema = z.object({
  actingParty: z.object({ kind: z.enum(["personal", "business"]), id: z.string().uuid() }),
  institutionDisplayName: z.string().trim().max(200).nullable().optional(),
  accountHolderName: z.string().trim().min(1).max(200),
  routingNumber: z.string().trim(),
  accountNumber: z.string().trim(),
  accountNumberConfirm: z.string().trim(),
  accountSubtype: z.enum(["checking", "savings"]),
});

/**
 * POST /api/relationships/accounts/bank/connect — Phase 6A's production bank-account connection
 * flow. Unlike /api/relationships/accounts/add (which requires an already-tokenized
 * `providerAccountRef`), this route is the one place that accepts a raw routing/account number — see
 * BankConnectionService's own doc comment for the full non-persistence contract. The response never
 * echoes back the raw values it received.
 */
export function createBankConnectHandler(authService: AuthService, bankConnectionService: BankConnectionService) {
  return async function handleConnect(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = connectSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid bank connection request is required.");
    }
    if (!(await checkRateLimit(`bank-connect:user:${userId}`, BANK_CONNECT_LIMIT_PER_USER, BANK_CONNECT_WINDOW_MS))) {
      throw new RateLimitedError("Too many bank connection attempts. Please try again later.");
    }
    const account = await bankConnectionService.connectBankAccount({
      actingUserId: userId,
      actingSessionId: sessionId,
      actingParty: parsed.data.actingParty,
      institutionDisplayName: parsed.data.institutionDisplayName ?? null,
      accountHolderName: parsed.data.accountHolderName,
      routingNumber: parsed.data.routingNumber,
      accountNumber: parsed.data.accountNumber,
      accountNumberConfirm: parsed.data.accountNumberConfirm,
      accountSubtype: parsed.data.accountSubtype,
    });
    return NextResponse.json({ account }, { status: 201 });
  };
}

async function handleConnect(request: NextRequest): Promise<Response> {
  return createBankConnectHandler(getAuthService(), getBankConnectionService())(request);
}

export const POST = withErrorHandling("relationship_account_bank_connect", handleConnect);
