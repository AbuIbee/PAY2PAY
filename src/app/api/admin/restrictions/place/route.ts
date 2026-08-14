import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdminRestrictionService } from "@/lib/admin/adminRestrictionService";
import { getAdminRestrictionService } from "@/lib/admin/getAdminRestrictionService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const placeSchema = z.object({
  restrictionType: z.enum(["payment_activity", "new_agreement_creation", "payout"]),
  targetResourceType: z.string().trim().min(1).max(100),
  targetResourceId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
  caseReference: z.string().trim().max(200).nullable().optional(),
});

/** Requires the capability matching restrictionType — enforced inside AdminRestrictionService.restrict itself. Not account suspension (Sprint 6A's own suspendUser), not Sprint 18A's relationship restriction, not Sprint 16's dispute restriction — see AdminRestrictionService's own doc comment for the full boundary. */
export function createAdminRestrictionPlaceHandler(authService: AuthService, restrictionService: AdminRestrictionService) {
  return async function handlePlace(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = placeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid restriction payload is required.");
    }
    const restriction = await restrictionService.restrict({
      restrictionType: parsed.data.restrictionType,
      targetResourceType: parsed.data.targetResourceType,
      targetResourceId: parsed.data.targetResourceId,
      reason: parsed.data.reason,
      caseReference: parsed.data.caseReference ?? null,
      actingUserId: userId,
      actingRole: platformRole,
    });
    return NextResponse.json({ restriction }, { status: 201 });
  };
}

async function handlePlace(request: NextRequest): Promise<Response> {
  return createAdminRestrictionPlaceHandler(getAuthService(), getAdminRestrictionService())(request);
}

export const POST = withErrorHandling("admin_restriction_place", handlePlace);
