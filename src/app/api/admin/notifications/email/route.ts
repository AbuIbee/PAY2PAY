import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { EmailDeliveryAdminService } from "@/lib/admin/emailDeliveryAdminService";
import { getEmailDeliveryAdminService } from "@/lib/admin/getEmailDeliveryAdminService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/notifications/email — the "review_email_delivery" capability-gated recent-email-events list (PRSprint 14, requirement #33). */
export function createEmailDeliveryListHandler(authService: AuthService, emailDeliveryAdminService: EmailDeliveryAdminService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const events = await emailDeliveryAdminService.listRecent(userId, platformRole);
    return NextResponse.json({ events }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createEmailDeliveryListHandler(getAuthService(), getEmailDeliveryAdminService())(request);
}

export const GET = withErrorHandling("admin_email_delivery_list", handleList);
