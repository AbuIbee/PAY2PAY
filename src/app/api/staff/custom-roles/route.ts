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

const createSchema = z.object({
  businessProfileId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  permissions: z.array(z.enum(CAPABILITIES)).min(1),
});

/** Custom-role creation always requires a fresh step-up — see StaffService.createCustomRole. */
export function createCustomRoleCreateHandler(authService: AuthService, staffService: StaffService) {
  return async function handleCreate(request: NextRequest): Promise<Response> {
    const { userId, sessionId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid custom role is required.");
    }

    const role = await staffService.createCustomRole({
      businessProfileId: parsed.data.businessProfileId,
      actingUserId: userId,
      actingSessionId: sessionId,
      name: parsed.data.name,
      permissions: parsed.data.permissions,
    });
    return NextResponse.json({ id: role.id, name: role.name, permissions: role.permissions }, { status: 201 });
  };
}

export function createCustomRoleListHandler(authService: AuthService, staffService: StaffService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const businessProfileId = new URL(request.url).searchParams.get("businessProfileId");
    if (!businessProfileId) throw new ValidationError("businessProfileId is required.");

    const roles = await staffService.listCustomRoles(businessProfileId, userId);
    return NextResponse.json(
      { customRoles: roles.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions })) },
      { status: 200 },
    );
  };
}

async function handleCreate(request: NextRequest): Promise<Response> {
  return createCustomRoleCreateHandler(getAuthService(), getStaffService())(request);
}

async function handleList(request: NextRequest): Promise<Response> {
  return createCustomRoleListHandler(getAuthService(), getStaffService())(request);
}

export const POST = withErrorHandling("staff_custom_role_create", handleCreate);
export const GET = withErrorHandling("staff_custom_role_list", handleList);
