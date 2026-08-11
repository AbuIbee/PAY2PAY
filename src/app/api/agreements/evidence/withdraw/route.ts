import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { EvidenceService } from "@/lib/evidence/evidenceService";
import { getEvidenceService } from "@/lib/evidence/getEvidenceService";
import { ValidationError } from "@/lib/errors";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const withdrawSchema = z.object({ evidenceId: z.string().uuid() });

export function createEvidenceWithdrawHandler(authService: AuthService, evidenceService: EvidenceService) {
  return async function handleWithdraw(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = withdrawSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("evidenceId is required.");

    await evidenceService.withdrawEvidence(parsed.data.evidenceId, userId, getClientIp(request), null);
    return NextResponse.json({ status: "withdrawn" }, { status: 200 });
  };
}

async function handleWithdraw(request: NextRequest): Promise<Response> {
  return createEvidenceWithdrawHandler(getAuthService(), getEvidenceService())(request);
}

export const POST = withErrorHandling("evidence_withdraw", handleWithdraw);
