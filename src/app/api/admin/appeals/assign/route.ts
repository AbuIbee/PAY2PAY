import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AppealService } from "@/lib/admin/appealService";
import { getAppealService } from "@/lib/admin/getAppealService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const assignSchema = z.object({ appealId: z.string().uuid(), reviewerUserId: z.string().uuid() });

/** Requires "manage_appeal"; rejects assigning the original decision-maker as reviewer — enforced inside AppealService.assignReviewer itself (and backed by a DB CHECK constraint). */
export function createAppealAssignHandler(authService: AuthService, appealService: AppealService) {
  return async function handleAssign(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = assignSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "appealId and reviewerUserId are required.");
    }
    const appeal = await appealService.assignReviewer({ appealId: parsed.data.appealId, reviewerUserId: parsed.data.reviewerUserId, actingUserId: userId, actingRole: platformRole });
    return NextResponse.json({ appeal }, { status: 200 });
  };
}

async function handleAssign(request: NextRequest): Promise<Response> {
  return createAppealAssignHandler(getAuthService(), getAppealService())(request);
}

export const POST = withErrorHandling("appeal_assign", handleAssign);
