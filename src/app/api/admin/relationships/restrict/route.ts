import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { RelationshipService } from "@/lib/relationships/relationshipService";
import { getRelationshipService } from "@/lib/relationships/getRelationshipService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const restrictSchema = z.object({ relationshipId: z.string().uuid(), reason: z.string().trim().min(1).max(2000) });

/** POST /api/admin/relationships/restrict — Platform Admin/Owner only, enforced inside RelationshipService.restrict itself (not just here). */
export function createAdminRelationshipRestrictHandler(authService: AuthService, relationshipService: RelationshipService) {
  return async function handleRestrict(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = restrictSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "relationshipId and a reason are required.");
    }
    const relationship = await relationshipService.restrict(parsed.data.relationshipId, userId, platformRole, parsed.data.reason);
    return NextResponse.json({ relationship }, { status: 200 });
  };
}

async function handleRestrict(request: NextRequest): Promise<Response> {
  return createAdminRelationshipRestrictHandler(getAuthService(), getRelationshipService())(request);
}

export const POST = withErrorHandling("admin_relationship_restrict", handleRestrict);
