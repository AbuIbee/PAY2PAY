import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getStaffService } from "@/lib/staff/getStaffService";
import type { StaffService } from "@/lib/staff/staffService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 4 (docs/sprints/SPRINT_04_BusinessStaff_Permissions.md). Listing is
 * gated only by active staff membership (StaffService.listStaff) — every
 * team member can see their own team roster; editing it needs manage_staff,
 * enforced per-action by the other /api/staff/* routes.
 */
export function createStaffListHandler(authService: AuthService, staffService: StaffService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const businessProfileId = new URL(request.url).searchParams.get("businessProfileId");
    if (!businessProfileId) throw new ValidationError("businessProfileId is required.");

    const staff = await staffService.listStaff(businessProfileId, userId);
    return NextResponse.json(
      {
        staff: staff.map((s) => ({
          id: s.id,
          userId: s.userId,
          role: s.role,
          customRoleId: s.customRoleId,
          isAuthorizedRepresentative: s.isAuthorizedRepresentative,
          createdAt: s.createdAt,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createStaffListHandler(getAuthService(), getStaffService())(request);
}

export const GET = withErrorHandling("staff_list", handleList);
