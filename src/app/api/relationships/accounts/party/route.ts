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

/** GET /api/relationships/accounts/party?partyKind=personal|business&partyId=... — every financial account a party owns, independent of any relationship (for the "Add Bank Account" / account-picker UI). */
export function createRelationshipPartyAccountsHandler(authService: AuthService, financialAccountService: RelationshipFinancialAccountService) {
  return async function handlePartyAccounts(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const searchParams = new URL(request.url).searchParams;
    const partyKind = searchParams.get("partyKind");
    const partyId = searchParams.get("partyId");
    if ((partyKind !== "personal" && partyKind !== "business") || !partyId) {
      throw new ValidationError("partyKind (personal|business) and partyId are required.");
    }
    const accounts = await financialAccountService.listAccountsForParty(userId, { kind: partyKind, id: partyId });
    return NextResponse.json({ accounts }, { status: 200 });
  };
}

async function handlePartyAccounts(request: NextRequest): Promise<Response> {
  return createRelationshipPartyAccountsHandler(getAuthService(), getRelationshipFinancialAccountService())(request);
}

export const GET = withErrorHandling("relationship_party_accounts_list", handlePartyAccounts);
