import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementProgressService } from "@/lib/agreements/agreementProgressService";
import { getAgreementProgressService } from "@/lib/agreements/getAgreementProgressService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agreement workflow remediation (Problem 3): read-only UX data — every gate this reports on is
 * independently enforced elsewhere (AgreementService.getAgreement's own authorizeEitherParty is the
 * real authorization check here; this route grants no access AgreementProgressService's own read
 * doesn't already require).
 */
export function createAgreementProgressHandler(authService: AuthService, progressService: AgreementProgressService) {
  return async function handleProgress(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");

    const progress = await progressService.getProgress(id, userId);
    return NextResponse.json(progress, { status: 200 });
  };
}

async function handleProgress(request: NextRequest): Promise<Response> {
  return createAgreementProgressHandler(getAuthService(), getAgreementProgressService())(request);
}

export const GET = withErrorHandling("agreement_progress", handleProgress);
