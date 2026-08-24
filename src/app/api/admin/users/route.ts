import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdminService } from "@/lib/admin/adminService";
import { getAdminService } from "@/lib/admin/getAdminService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createAdminUsersSearchHandler(authService: AuthService, adminService: AdminService) {
  return async function handleSearch(request: NextRequest): Promise<Response> {
    const { platformRole } = await requireSession(request, authService);
    const url = new URL(request.url);
    const email = url.searchParams.get("email") ?? undefined;
    const userId = url.searchParams.get("userId") ?? undefined;
    const publicReference = url.searchParams.get("publicReference") ?? undefined;
    const users = await adminService.searchUsers(platformRole, { email, userId, publicReference });
    return NextResponse.json({ users }, { status: 200 });
  };
}

async function handleSearch(request: NextRequest): Promise<Response> {
  return createAdminUsersSearchHandler(getAuthService(), getAdminService())(request);
}

export const GET = withErrorHandling("admin_users_search", handleSearch);
