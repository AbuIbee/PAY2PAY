import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { RetentionHoldService } from "@/lib/admin/retentionHoldService";
import { getRetentionHoldService } from "@/lib/admin/getRetentionHoldService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const releaseSchema = z.object({ holdId: z.string().uuid(), reason: z.string().trim().max(2000).optional() });

export function createRetentionHoldReleaseHandler(authService: AuthService, retentionHoldService: RetentionHoldService) {
  return async function handleRelease(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = releaseSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "holdId is required.");
    }
    const hold = await retentionHoldService.releaseHold({ holdId: parsed.data.holdId, actingUserId: userId, actingRole: platformRole, reason: parsed.data.reason ?? null });
    return NextResponse.json({ hold }, { status: 200 });
  };
}

async function handleRelease(request: NextRequest): Promise<Response> {
  return createRetentionHoldReleaseHandler(getAuthService(), getRetentionHoldService())(request);
}

export const POST = withErrorHandling("retention_hold_release", handleRelease);
