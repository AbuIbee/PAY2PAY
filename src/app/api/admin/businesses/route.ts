import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdminService } from "@/lib/admin/adminService";
import { getAdminService } from "@/lib/admin/getAdminService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PRSprint 11B: GET /api/admin/businesses?name=&businessId= — mirrors GET /api/admin/users. */
export function createAdminBusinessesSearchHandler(authService: AuthService, adminService: AdminService) {
  return async function handleSearch(request: NextRequest): Promise<Response> {
    const { platformRole } = await requireSession(request, authService);
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? undefined;
    const businessId = url.searchParams.get("businessId") ?? undefined;
    const businesses = await adminService.searchBusinesses(platformRole, { name, businessId });
    return NextResponse.json({ businesses }, { status: 200 });
  };
}

async function handleSearch(request: NextRequest): Promise<Response> {
  return createAdminBusinessesSearchHandler(getAuthService(), getAdminService())(request);
}

export const GET = withErrorHandling("admin_businesses_search", handleSearch);
