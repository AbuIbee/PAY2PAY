import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { DrizzleStaffDisplayReader } from "@/lib/staff/drizzleStaffDisplayReader";
import { getStaffService } from "@/lib/staff/getStaffService";
import type { StaffDisplayReader } from "@/lib/staff/staffDisplayReader";
import type { StaffService } from "@/lib/staff/staffService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 4 (docs/sprints/SPRINT_04_BusinessStaff_Permissions.md). Listing is
 * gated only by active staff membership (StaffService.listStaff) — every
 * team member can see their own team roster; editing it needs manage_staff,
 * enforced per-action by the other /api/staff/* routes.
 *
 * PRSprint 25: also resolves each member's name/email via `displayReader`
 * (master-spec item 11 requires name/email on staff rows; item 5 bans a raw
 * UUID as the only user-facing identifier) — a never-set name falls back to
 * "Member" client-side, never a truncated UUID.
 */
export function createStaffListHandler(authService: AuthService, staffService: StaffService, displayReader: StaffDisplayReader) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const businessProfileId = new URL(request.url).searchParams.get("businessProfileId");
    if (!businessProfileId) throw new ValidationError("businessProfileId is required.");

    const staff = await staffService.listStaff(businessProfileId, userId);
    const displayInfo = await displayReader.loadDisplayInfo(staff.map((s) => s.userId));
    return NextResponse.json(
      {
        staff: staff.map((s) => ({
          id: s.id,
          userId: s.userId,
          name: displayInfo.get(s.userId)?.name ?? null,
          email: displayInfo.get(s.userId)?.email ?? null,
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
  return createStaffListHandler(getAuthService(), getStaffService(), new DrizzleStaffDisplayReader())(request);
}

export const GET = withErrorHandling("staff_list", handleList);
