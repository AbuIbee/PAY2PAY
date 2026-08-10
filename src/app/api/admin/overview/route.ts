import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdminService } from "@/lib/admin/adminService";
import { getAdminService } from "@/lib/admin/getAdminService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createAdminOverviewHandler(authService: AuthService, adminService: AdminService) {
  return async function handleOverview(request: NextRequest): Promise<Response> {
    const { platformRole } = await requireSession(request, authService);
    const overview = await adminService.getDashboardOverview(platformRole);
    return NextResponse.json(overview, { status: 200 });
  };
}

async function handleOverview(request: NextRequest): Promise<Response> {
  return createAdminOverviewHandler(getAuthService(), getAdminService())(request);
}

export const GET = withErrorHandling("admin_overview", handleOverview);
