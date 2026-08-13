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

/** GET /api/admin/relationships/accounts?relationshipId=... — admin connector (Phase 37): masked financial-account view, see AdminFinancialAccountAssignmentView's own doc comment for exactly what is/isn't exposed. */
export function createAdminRelationshipAccountsHandler(authService: AuthService, financialAccountService: RelationshipFinancialAccountService) {
  return async function handleAdminAccounts(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const relationshipId = new URL(request.url).searchParams.get("relationshipId");
    if (!relationshipId) throw new ValidationError("relationshipId is required.");
    const assignments = await financialAccountService.getRelationshipAccountsForAdmin(relationshipId, userId, platformRole);
    return NextResponse.json({ assignments }, { status: 200 });
  };
}

async function handleAdminAccounts(request: NextRequest): Promise<Response> {
  return createAdminRelationshipAccountsHandler(getAuthService(), getRelationshipFinancialAccountService())(request);
}

export const GET = withErrorHandling("admin_relationship_accounts", handleAdminAccounts);
