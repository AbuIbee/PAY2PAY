import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { RelationshipFinancialAccountService } from "@/lib/relationships/relationshipFinancialAccountService";
import { getRelationshipFinancialAccountService } from "@/lib/relationships/getRelationshipFinancialAccountService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/relationships/accounts?relationshipId=... — the funding/payout assignments for a relationship the caller participates in. */
export function createRelationshipAccountsHandler(authService: AuthService, financialAccountService: RelationshipFinancialAccountService) {
  return async function handleAccounts(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const relationshipId = new URL(request.url).searchParams.get("relationshipId");
    if (!relationshipId) throw new ValidationError("relationshipId is required.");
    const assignments = await financialAccountService.getRelationshipAccounts(relationshipId, userId);
    return NextResponse.json({ assignments }, { status: 200 });
  };
}

async function handleAccounts(request: NextRequest): Promise<Response> {
  return createRelationshipAccountsHandler(getAuthService(), getRelationshipFinancialAccountService())(request);
}

export const GET = withErrorHandling("relationship_accounts_list", handleAccounts);
