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

const activateSchema = z.object({ relationshipId: z.string().uuid() });

export function createRelationshipActivateHandler(authService: AuthService, relationshipService: RelationshipService) {
  return async function handleActivate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = activateSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "relationshipId is required.");
    }
    const relationship = await relationshipService.activate(parsed.data.relationshipId, userId);
    return NextResponse.json({ relationship }, { status: 200 });
  };
}

async function handleActivate(request: NextRequest): Promise<Response> {
  return createRelationshipActivateHandler(getAuthService(), getRelationshipService())(request);
}

export const POST = withErrorHandling("relationship_activate", handleActivate);
