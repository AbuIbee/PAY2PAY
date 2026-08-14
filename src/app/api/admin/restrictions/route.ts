import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdminRestrictionService } from "@/lib/admin/adminRestrictionService";
import { getAdminRestrictionService } from "@/lib/admin/getAdminRestrictionService";
import { isAdminRole } from "@/lib/admin/capabilities";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ForbiddenError, ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/restrictions?targetResourceType=&targetResourceId= — every restriction (active and lifted) for one target. `AdminRestrictionService.listForTarget` itself is ungated (a read with no sensitive detail beyond the reason text), so this route applies the base admin gate directly. */
export function createAdminRestrictionListHandler(authService: AuthService, restrictionService: AdminRestrictionService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { platformRole } = await requireSession(request, authService);
    if (!isAdminRole(platformRole)) {
      throw new ForbiddenError("Administrative access is required.");
    }
    const searchParams = new URL(request.url).searchParams;
    const targetResourceType = searchParams.get("targetResourceType");
    const targetResourceId = searchParams.get("targetResourceId");
    if (!targetResourceType || !targetResourceId) {
      throw new ValidationError("targetResourceType and targetResourceId are required.");
    }
    const restrictions = await restrictionService.listForTarget(targetResourceType, targetResourceId);
    return NextResponse.json({ restrictions }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createAdminRestrictionListHandler(getAuthService(), getAdminRestrictionService())(request);
}

export const GET = withErrorHandling("admin_restriction_list", handleList);
