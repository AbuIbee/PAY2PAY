import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { RetentionHoldService } from "@/lib/admin/retentionHoldService";
import { getRetentionHoldService } from "@/lib/admin/getRetentionHoldService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const placeSchema = z.object({
  targetResourceType: z.string().trim().min(1).max(100),
  targetResourceId: z.string().uuid(),
  holdType: z.enum(["retention", "dispute", "fraud_review", "litigation", "administrative_override"]),
  reason: z.string().trim().min(1).max(2000),
});

/** Requires the "place_retention_hold" capability — enforced inside RetentionHoldService.placeHold itself. */
export function createRetentionHoldPlaceHandler(authService: AuthService, retentionHoldService: RetentionHoldService) {
  return async function handlePlace(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = placeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid retention hold payload is required.");
    }
    const hold = await retentionHoldService.placeHold({ ...parsed.data, actingUserId: userId, actingRole: platformRole });
    return NextResponse.json({ hold }, { status: 201 });
  };
}

async function handlePlace(request: NextRequest): Promise<Response> {
  return createRetentionHoldPlaceHandler(getAuthService(), getRetentionHoldService())(request);
}

export const POST = withErrorHandling("retention_hold_place", handlePlace);
