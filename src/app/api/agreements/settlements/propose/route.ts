import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { SettlementService } from "@/lib/settlements/settlementService";
import { getSettlementService } from "@/lib/settlements/getSettlementService";
import { settlementTermsSchema } from "@/lib/settlements/validation";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const proposeSchema = settlementTermsSchema.extend({ agreementId: z.string().uuid() });

/**
 * Master spec §12: either the creditor or the borrower may propose a settlement
 * (SettlementService.proposeSettlement). `sessionId` is passed through because a creditor-authored
 * proposal is itself step-up-gated (Product Owner review pass finding — see settlementService.ts's
 * class doc comment): it already fixes the forgiveness terms the debtor need only accept as-is.
 */
export function createSettlementProposeHandler(authService: AuthService, settlementService: SettlementService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = proposeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid settlement proposal is required.");
    }
    const record = await settlementService.proposeSettlement({ ...parsed.data, actingUserId: userId, actingSessionId: sessionId });
    return NextResponse.json(record, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createSettlementProposeHandler(getAuthService(), getSettlementService())(request);
}

export const POST = withErrorHandling("settlement_propose", handlePost);
