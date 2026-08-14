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

const submitSchema = z.object({
  targetResourceType: z.string().trim().min(1).max(100),
  targetResourceId: z.string().uuid(),
  originalDecisionSummary: z.string().trim().min(1).max(4000),
  originalDecisionByUserId: z.string().uuid().nullable().optional(),
  evidenceDescription: z.string().trim().max(4000).nullable().optional(),
});

/** User-initiated — any authenticated user may appeal a decision made against their own account; never admin-gated on submission (AppealService.submitAppeal itself never checks a capability). */
export function createAppealSubmitHandler(authService: AuthService, appealService: AppealService) {
  return async function handleSubmit(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = submitSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid appeal payload is required.");
    }
    const appeal = await appealService.submitAppeal({
      appealingUserId: userId,
      targetResourceType: parsed.data.targetResourceType,
      targetResourceId: parsed.data.targetResourceId,
      originalDecisionSummary: parsed.data.originalDecisionSummary,
      originalDecisionByUserId: parsed.data.originalDecisionByUserId ?? null,
      evidenceDescription: parsed.data.evidenceDescription ?? null,
    });
    return NextResponse.json({ appeal }, { status: 201 });
  };
}

async function handleSubmit(request: NextRequest): Promise<Response> {
  return createAppealSubmitHandler(getAuthService(), getAppealService())(request);
}

export const POST = withErrorHandling("appeal_submit", handleSubmit);
