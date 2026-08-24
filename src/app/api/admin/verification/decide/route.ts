import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { VerificationService } from "@/lib/profiles/verificationService";
import { getVerificationService } from "@/lib/profiles/getVerificationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A rejection must always carry a stated reason (mirrors AppealService.decideAppeal's identical
// required-rationale precedent); an approval reason is optional but still recorded when given.
const decideSchema = z
  .object({
    profileKind: z.enum(["personal", "business"]),
    profileId: z.string().uuid(),
    decision: z.enum(["verified", "rejected"]),
    reason: z.string().trim().min(1).max(4000).nullable().optional(),
  })
  .refine((v) => v.decision !== "rejected" || (typeof v.reason === "string" && v.reason.length > 0), {
    message: "A reason is required when rejecting a verification request.",
    path: ["reason"],
  });

/**
 * Closed-beta remediation (DEF-UAT-020): the actual approve/reject action over a pending identity-
 * verification request. This is the first real caller of
 * VerificationService.recordManualVerificationDecision, which previously existed with zero production
 * route — the reason no party could ever move past "pending" and therefore why no agreement could
 * ever be signed and no payment could ever be created anywhere in this system.
 */
export function createAdminVerificationDecideHandler(authService: AuthService, verification: VerificationService) {
  return async function handleDecide(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = decideSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid profileKind, profileId, and decision are required.");
    }
    await verification.recordManualVerificationDecision({
      actingRole: platformRole,
      profileKind: parsed.data.profileKind,
      profileId: parsed.data.profileId,
      decision: parsed.data.decision,
      reviewerUserId: userId,
      reason: parsed.data.reason ?? null,
    });
    return NextResponse.json({ status: "ok" }, { status: 200 });
  };
}

async function handleDecide(request: NextRequest): Promise<Response> {
  return createAdminVerificationDecideHandler(getAuthService(), getVerificationService())(request);
}

export const POST = withErrorHandling("admin_verification_decide", handleDecide);
