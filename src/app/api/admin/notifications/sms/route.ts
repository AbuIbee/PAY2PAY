import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { SmsDeliveryAdminService } from "@/lib/admin/smsDeliveryAdminService";
import { getSmsDeliveryAdminService } from "@/lib/admin/getSmsDeliveryAdminService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/notifications/sms — the "review_sms_delivery" capability-gated recent-SMS-events list (PRSprint 15, requirement #27). */
export function createSmsDeliveryListHandler(authService: AuthService, smsDeliveryAdminService: SmsDeliveryAdminService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const events = await smsDeliveryAdminService.listRecent(userId, platformRole);
    return NextResponse.json({ events }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createSmsDeliveryListHandler(getAuthService(), getSmsDeliveryAdminService())(request);
}

export const GET = withErrorHandling("admin_sms_delivery_list", handleList);
