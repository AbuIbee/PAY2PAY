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

/** GET /api/relationships/detail?id=... — a single relationship plus its participants. Authorization (must be a participant) is enforced by RelationshipService.getRelationship itself, not here. */
export function createRelationshipDetailHandler(authService: AuthService, relationshipService: RelationshipService) {
  return async function handleDetail(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");
    const result = await relationshipService.getRelationship(id, userId);
    return NextResponse.json(result, { status: 200 });
  };
}

async function handleDetail(request: NextRequest): Promise<Response> {
  return createRelationshipDetailHandler(getAuthService(), getRelationshipService())(request);
}

export const GET = withErrorHandling("relationship_detail", handleDetail);
