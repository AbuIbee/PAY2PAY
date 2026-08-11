import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { getAchMandateService } from "@/lib/ach/getAchMandateService";
import type { AchMandateService } from "@/lib/ach/achMandateService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const revokeSchema = z.object({
  mandateId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});

/** Sprint 11: revocation stops future automatic debits but does not erase debt — AchMandateService is structurally incapable of touching agreement/ledger data. */
export function createAchMandateRevokeHandler(authService: AuthService, achMandateService: AchMandateService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = revokeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid revocation request is required.");
    }
    const mandate = await achMandateService.revoke({
      mandateId: parsed.data.mandateId,
      actingUserId: userId,
      reason: parsed.data.reason,
    });
    return NextResponse.json(mandate, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAchMandateRevokeHandler(getAuthService(), getAchMandateService())(request);
}

export const POST = withErrorHandling("ach_mandate_revoke", handlePost);
