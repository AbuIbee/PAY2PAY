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

const assignSchema = z.object({
  relationshipId: z.string().uuid(),
  financialAccountId: z.string().uuid(),
  usage: z.enum(["funding", "payout"]),
});

export function createRelationshipAccountAssignHandler(authService: AuthService, financialAccountService: RelationshipFinancialAccountService) {
  return async function handleAssign(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = assignSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "relationshipId, financialAccountId, and usage are required.");
    }
    const assignment = await financialAccountService.assignAccount({
      relationshipId: parsed.data.relationshipId,
      actingUserId: userId,
      financialAccountId: parsed.data.financialAccountId,
      usage: parsed.data.usage,
    });
    return NextResponse.json({ assignment }, { status: 201 });
  };
}

async function handleAssign(request: NextRequest): Promise<Response> {
  return createRelationshipAccountAssignHandler(getAuthService(), getRelationshipFinancialAccountService())(request);
}

export const POST = withErrorHandling("relationship_account_assign", handleAssign);
