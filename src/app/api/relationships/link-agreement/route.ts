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

const linkSchema = z.object({ relationshipId: z.string().uuid(), agreementId: z.string().uuid() });

/**
 * Sprint 18B: thin route over RelationshipService.linkAgreement, which already existed (Sprint 18A)
 * but had no route exposing it — the agreement creation wizard calls this immediately after
 * creating a draft agreement out of a selected connection, so the relationship's own setup tracker
 * (Sprint 18A) can progress past "agreement ready" instead of the two staying permanently
 * disconnected. No new business logic — RelationshipService.linkAgreement already enforces "only
 * once per relationship" and party authorization.
 */
export function createRelationshipLinkAgreementHandler(authService: AuthService, relationshipService: RelationshipService) {
  return async function handleLink(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = linkSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "relationshipId and agreementId are required.");
    }
    const relationship = await relationshipService.linkAgreement(parsed.data.relationshipId, parsed.data.agreementId, userId);
    return NextResponse.json({ relationship }, { status: 200 });
  };
}

async function handleLink(request: NextRequest): Promise<Response> {
  return createRelationshipLinkAgreementHandler(getAuthService(), getRelationshipService())(request);
}

export const POST = withErrorHandling("relationship_link_agreement", handleLink);
