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

/** Manual UAT remediation (#10 "Bank Account Removal") — previously no route existed anywhere calling `RelationshipFinancialAccountService.disableAccount`, even though that method itself already existed. */
const removeSchema = z.object({
  financialAccountId: z.string().uuid(),
  actingParty: z.object({ kind: z.enum(["personal", "business"]), id: z.string().uuid() }),
  reason: z.string().trim().min(1).max(500),
});

export function createRelationshipAccountRemoveHandler(authService: AuthService, financialAccountService: RelationshipFinancialAccountService) {
  return async function handleRemove(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = removeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "financialAccountId, actingParty, and reason are required.");
    }
    const account = await financialAccountService.disableAccount({
      financialAccountId: parsed.data.financialAccountId,
      actingUserId: userId,
      actingParty: parsed.data.actingParty,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ account }, { status: 200 });
  };
}

async function handleRemove(request: NextRequest): Promise<Response> {
  return createRelationshipAccountRemoveHandler(getAuthService(), getRelationshipFinancialAccountService())(request);
}

export const POST = withErrorHandling("relationship_account_remove", handleRemove);
