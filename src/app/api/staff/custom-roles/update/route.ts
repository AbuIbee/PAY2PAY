import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { CAPABILITIES } from "@/lib/staff/capabilities";
import { ValidationError } from "@/lib/errors";
import { getStaffService } from "@/lib/staff/getStaffService";
import type { StaffService } from "@/lib/staff/staffService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  businessProfileId: z.string().uuid(),
  customRoleId: z.string().uuid(),
  name: z.string().trim().min(1).max(100).optional(),
  permissions: z.array(z.enum(CAPABILITIES)).min(1).optional(),
});

/** Custom-role edits always require a fresh step-up — see StaffService.updateCustomRole. */
export function createCustomRoleUpdateHandler(authService: AuthService, staffService: StaffService) {
  return async function handleUpdate(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = updateSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid custom role update is required.");
    }

    await staffService.updateCustomRole({
      businessProfileId: parsed.data.businessProfileId,
      actingUserId: userId,
      actingSessionId: sessionId,
      customRoleId: parsed.data.customRoleId,
      name: parsed.data.name,
      permissions: parsed.data.permissions,
    });
    return NextResponse.json({ status: "updated" }, { status: 200 });
  };
}

async function handleUpdate(request: NextRequest): Promise<Response> {
  return createCustomRoleUpdateHandler(getAuthService(), getStaffService())(request);
}

export const POST = withErrorHandling("staff_custom_role_update", handleUpdate);
