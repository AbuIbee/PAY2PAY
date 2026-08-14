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

const revokeSchema = z.object({ assignmentId: z.string().uuid(), reason: z.string().trim().max(2000).optional() });

export function createAdminRoleRevokeHandler(authService: AuthService, adminRoleService: AdminRoleService) {
  return async function handleRevoke(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = revokeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "assignmentId is required.");
    }
    const assignment = await adminRoleService.revokeRole({
      assignmentId: parsed.data.assignmentId,
      actingUserId: userId,
      actingRole: platformRole,
      reason: parsed.data.reason ?? null,
    });
    return NextResponse.json({ assignment }, { status: 200 });
  };
}

async function handleRevoke(request: NextRequest): Promise<Response> {
  return createAdminRoleRevokeHandler(getAuthService(), getAdminRoleService())(request);
}

export const POST = withErrorHandling("admin_role_revoke", handleRevoke);
