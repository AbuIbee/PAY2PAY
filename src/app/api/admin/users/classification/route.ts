import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AdminService } from "@/lib/admin/adminService";
import { getAdminService } from "@/lib/admin/getAdminService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const classificationSchema = z.object({
  targetUserId: z.string().uuid(),
  classification: z.enum(["production", "internal", "qa", "demo", "automated_test"]),
});

export function createAdminChangeClassificationHandler(authService: AuthService, adminService: AdminService) {
  return async function handleClassification(request: NextRequest): Promise<Response> {
    const { userId, sessionId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = classificationSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid targetUserId and classification are required.");
    }
    await adminService.changeAccountClassification(
      { actingUserId: userId, actingSessionId: sessionId, actingRole: platformRole, ipAddress: getClientIp(request), deviceInfo: null },
      parsed.data.targetUserId,
      parsed.data.classification,
    );
    return NextResponse.json({ status: "classification_changed" }, { status: 200 });
  };
}

async function handleClassification(request: NextRequest): Promise<Response> {
  return createAdminChangeClassificationHandler(getAuthService(), getAdminService())(request);
}

export const POST = withErrorHandling("admin_change_classification", handleClassification);
