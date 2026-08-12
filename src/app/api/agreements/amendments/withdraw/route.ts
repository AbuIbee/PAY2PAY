import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AmendmentService } from "@/lib/amendments/amendmentService";
import { getAmendmentService } from "@/lib/amendments/getAmendmentService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const withdrawSchema = z.object({
  amendmentId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000).optional(),
});

/** Only the proposer may withdraw their own not-yet-fully-signed amendment. */
export function createAmendmentWithdrawHandler(authService: AuthService, amendmentService: AmendmentService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = withdrawSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid amendment id is required.");
    }
    const record = await amendmentService.withdrawAmendment({
      amendmentId: parsed.data.amendmentId,
      actingUserId: userId,
      reason: parsed.data.reason,
    });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAmendmentWithdrawHandler(getAuthService(), getAmendmentService())(request);
}

export const POST = withErrorHandling("amendment_withdraw", handlePost);
