import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/agreements/versions?agreementId=... — PRSprint 11 (docs/prsprints/PRSPRINT_11_
 * AGREEMENT_VERSIONING_AMENDMENTS_MUTUAL_APPROVAL.md): "historical agreement versions must remain
 * retrievable." Same authorization as /api/agreements/detail (either party only, via
 * AgreementService.listVersionHistory's own `authorizeEitherParty` call) — this is a read-only
 * history view, never a way to select which version is "current" or to mutate anything.
 */
export function createAgreementVersionsHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleVersions(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");

    const versions = await agreementService.listVersionHistory(agreementId, userId);
    return NextResponse.json(
      {
        versions: versions.map((version) => ({
          id: version.id,
          versionNumber: version.versionNumber,
          parentVersionId: version.parentVersionId,
          isOriginal: version.isOriginal,
          producedBy: version.producedBy,
          frequency: version.frequency,
          feeAllocation: version.feeAllocation,
          terms: version.terms,
          creditorSignedAt: version.creditorSignedAt,
          debtorSignedAt: version.debtorSignedAt,
          signedAt: version.signedAt,
          documentHash: version.documentHash,
          createdAt: version.createdAt,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleVersions(request: NextRequest): Promise<Response> {
  return createAgreementVersionsHandler(getAuthService(), getAgreementService())(request);
}

export const GET = withErrorHandling("agreement_versions", handleVersions);
