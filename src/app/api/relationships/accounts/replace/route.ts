import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { RelationshipFinancialAccountService } from "@/lib/relationships/relationshipFinancialAccountService";
import { getRelationshipFinancialAccountService } from "@/lib/relationships/getRelationshipFinancialAccountService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const replaceSchema = z.object({
  relationshipId: z.string().uuid(),
  financialAccountId: z.string().uuid(),
  usage: z.enum(["funding", "payout"]),
});

/** POST /api/relationships/accounts/replace — Phase 18's financial-account replacement: never overwrites history, see RelationshipFinancialAccountService.replaceAccount's own doc comment for why no counterparty approval is required. */
export function createRelationshipAccountReplaceHandler(authService: AuthService, financialAccountService: RelationshipFinancialAccountService) {
  return async function handleReplace(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = replaceSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "relationshipId, financialAccountId, and usage are required.");
    }
    const assignment = await financialAccountService.replaceAccount({
      relationshipId: parsed.data.relationshipId,
      actingUserId: userId,
      actingSessionId: sessionId,
      financialAccountId: parsed.data.financialAccountId,
      usage: parsed.data.usage,
    });
    return NextResponse.json({ assignment }, { status: 200 });
  };
}

async function handleReplace(request: NextRequest): Promise<Response> {
  return createRelationshipAccountReplaceHandler(getAuthService(), getRelationshipFinancialAccountService())(request);
}

export const POST = withErrorHandling("relationship_account_replace", handleReplace);
