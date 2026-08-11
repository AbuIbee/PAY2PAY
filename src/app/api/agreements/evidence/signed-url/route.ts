import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { EvidenceService } from "@/lib/evidence/evidenceService";
import { getEvidenceService } from "@/lib/evidence/getEvidenceService";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createEvidenceSignedUrlHandler(authService: AuthService, evidenceService: EvidenceService) {
  return async function handleSignedUrl(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");

    const signedUrl = await evidenceService.getSignedEvidenceUrl(id, userId);
    return NextResponse.json({ signedUrl }, { status: 200 });
  };
}

async function handleSignedUrl(request: NextRequest): Promise<Response> {
  return createEvidenceSignedUrlHandler(getAuthService(), getEvidenceService())(request);
}

export const GET = withErrorHandling("evidence_signed_url", handleSignedUrl);
