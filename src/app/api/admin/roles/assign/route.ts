import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdminRoleService } from "@/lib/admin/adminRoleService";
import { getAdminRoleService } from "@/lib/admin/getAdminRoleService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const assignSchema = z.object({
  targetUserId: z.string().uuid(),
  role: z.enum(["support", "compliance", "fraud_reviewer", "admin"]),
  reason: z.string().trim().max(2000).optional(),
});

/** Platform Owner only — enforced inside AdminRoleService.assignRole itself, not just here. */
export function createAdminRoleAssignHandler(authService: AuthService, adminRoleService: AdminRoleService) {
  return async function handleAssign(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = assignSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "targetUserId and role are required.");
    }
    const assignment = await adminRoleService.assignRole({
      targetUserId: parsed.data.targetUserId,
      role: parsed.data.role,
      actingUserId: userId,
      actingRole: platformRole,
      reason: parsed.data.reason ?? null,
    });
    return NextResponse.json({ assignment }, { status: 201 });
  };
}

async function handleAssign(request: NextRequest): Promise<Response> {
  return createAdminRoleAssignHandler(getAuthService(), getAdminRoleService())(request);
}

export const POST = withErrorHandling("admin_role_assign", handleAssign);
