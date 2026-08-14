import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { RetentionHoldService } from "@/lib/admin/retentionHoldService";
import { getRetentionHoldService } from "@/lib/admin/getRetentionHoldService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/retention/holds?targetResourceType=&targetResourceId=&active=true — lists holds for one target, or every active hold platform-wide when neither query param is given. */
export function createRetentionHoldListHandler(authService: AuthService, retentionHoldService: RetentionHoldService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const searchParams = new URL(request.url).searchParams;
    const targetResourceType = searchParams.get("targetResourceType");
    const targetResourceId = searchParams.get("targetResourceId");
    if (targetResourceType && targetResourceId) {
      const holds = await retentionHoldService.listHoldsForTarget({ targetResourceType, targetResourceId, actingUserId: userId, actingRole: platformRole });
      return NextResponse.json({ holds }, { status: 200 });
    }
    if (targetResourceType || targetResourceId) {
      throw new ValidationError("Both targetResourceType and targetResourceId are required together.");
    }
    const holds = await retentionHoldService.listActiveHolds(userId, platformRole);
    return NextResponse.json({ holds }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createRetentionHoldListHandler(getAuthService(), getRetentionHoldService())(request);
}

export const GET = withErrorHandling("retention_hold_list", handleList);
