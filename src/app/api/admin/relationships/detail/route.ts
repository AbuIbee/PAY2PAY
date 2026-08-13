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

/** GET /api/admin/relationships/detail?id=... — admin connector (Phase 37): read-only support view, itself audited by RelationshipService.getRelationshipForAdmin. */
export function createAdminRelationshipDetailHandler(authService: AuthService, relationshipService: RelationshipService) {
  return async function handleAdminDetail(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");
    const result = await relationshipService.getRelationshipForAdmin(id, userId, platformRole);
    return NextResponse.json(result, { status: 200 });
  };
}

async function handleAdminDetail(request: NextRequest): Promise<Response> {
  return createAdminRelationshipDetailHandler(getAuthService(), getRelationshipService())(request);
}

export const GET = withErrorHandling("admin_relationship_detail", handleAdminDetail);
