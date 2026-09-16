import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getBankConnectionService } from "@/lib/relationships/getBankConnectionService";
import type { BankConnectionService } from "@/lib/relationships/bankConnectionService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction): this route's PURPOSE changes from
 * "finalize a bank connection" (a client-triggered mutation trusting a before/after token-list diff —
 * removed entirely, see `BankConnectionService`'s own doc comment) to a purely READ-ONLY status poll.
 * The client never POSTs a completion claim this server would need to trust; completion happens
 * exclusively via two Adyen webhooks (`/api/payments/webhook`'s AUTHORISATION handling and
 * `/api/payments/webhook/tokens`'s token-lifecycle handling). This route only ever reports the
 * CURRENT, webhook-driven status of an attempt the caller is confirmed to own.
 */
const statusQuerySchema = z.object({
  actingPartyKind: z.enum(["personal", "business"]),
  actingPartyId: z.string().uuid(),
  providerSessionId: z.string().trim().min(1).max(200),
});

export function createBankConnectionStatusHandler(authService: AuthService, bankConnectionService: BankConnectionService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = statusQuerySchema.safeParse({
      actingPartyKind: url.searchParams.get("actingPartyKind"),
      actingPartyId: url.searchParams.get("actingPartyId"),
      providerSessionId: url.searchParams.get("providerSessionId"),
    });
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid status request is required.");
    }
    const result = await bankConnectionService.getBankLinkAttemptStatus({
      actingUserId: userId,
      actingParty: { kind: parsed.data.actingPartyKind, id: parsed.data.actingPartyId },
      providerSessionId: parsed.data.providerSessionId,
    });
    return NextResponse.json(result, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createBankConnectionStatusHandler(getAuthService(), getBankConnectionService())(request);
}

export const GET = withErrorHandling("relationship_account_bank_connect_status", handleGet);
