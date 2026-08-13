import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { RelationshipService } from "@/lib/relationships/relationshipService";
import { getRelationshipService } from "@/lib/relationships/getRelationshipService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/relationships?partyKind=personal|business&partyId=... — every relationship the acting user's party participates in. */
export function createRelationshipListHandler(authService: AuthService, relationshipService: RelationshipService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const searchParams = new URL(request.url).searchParams;
    const partyKind = searchParams.get("partyKind");
    const partyId = searchParams.get("partyId");
    if ((partyKind !== "personal" && partyKind !== "business") || !partyId) {
      throw new ValidationError("partyKind (personal|business) and partyId are required.");
    }
    const relationships = await relationshipService.listRelationshipsForParty(userId, { kind: partyKind, id: partyId });
    return NextResponse.json({ relationships }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createRelationshipListHandler(getAuthService(), getRelationshipService())(request);
}

export const GET = withErrorHandling("relationship_list", handleList);
