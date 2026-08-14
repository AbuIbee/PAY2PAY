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

const liftSchema = z.object({ restrictionId: z.string().uuid(), reason: z.string().trim().max(2000).optional() });

export function createAdminRestrictionLiftHandler(authService: AuthService, restrictionService: AdminRestrictionService) {
  return async function handleLift(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = liftSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "restrictionId is required.");
    }
    const restriction = await restrictionService.lift({ restrictionId: parsed.data.restrictionId, actingUserId: userId, actingRole: platformRole, reason: parsed.data.reason ?? null });
    return NextResponse.json({ restriction }, { status: 200 });
  };
}

async function handleLift(request: NextRequest): Promise<Response> {
  return createAdminRestrictionLiftHandler(getAuthService(), getAdminRestrictionService())(request);
}

export const POST = withErrorHandling("admin_restriction_lift", handleLift);
