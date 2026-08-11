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

const flagSchema = z.object({ evidenceId: z.string().uuid(), flag: z.boolean() });

export function createEvidenceDisputeFlagHandler(authService: AuthService, evidenceService: EvidenceService) {
  return async function handleFlag(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = flagSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("evidenceId and flag are required.");

    await evidenceService.setDisputeFlag(parsed.data.evidenceId, userId, parsed.data.flag, getClientIp(request), null);
    return NextResponse.json({ status: "updated" }, { status: 200 });
  };
}

async function handleFlag(request: NextRequest): Promise<Response> {
  return createEvidenceDisputeFlagHandler(getAuthService(), getEvidenceService())(request);
}

export const POST = withErrorHandling("evidence_dispute_flag", handleFlag);
