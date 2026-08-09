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

export function createAgreementDetailHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleDetail(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");

    const result = await agreementService.getAgreement(id, userId);
    return NextResponse.json(
      {
        id: result.agreement.id,
        status: result.agreement.status,
        currency: result.agreement.currency,
        relationshipShape: agreementService.relationshipShape(result.agreement),
        creditor: { kind: result.agreement.creditorProfileKind, id: result.agreement.creditorProfileId },
        debtor: { kind: result.agreement.debtorProfileKind, id: result.agreement.debtorProfileId },
        version: {
          id: result.version.id,
          versionNumber: result.version.versionNumber,
          frequency: result.version.frequency,
          feeAllocation: result.version.feeAllocation,
          terms: result.version.terms,
          creditorSignedAt: result.version.creditorSignedAt,
          debtorSignedAt: result.version.debtorSignedAt,
          signedAt: result.version.signedAt,
          documentHash: result.version.documentHash,
        },
        schedule: result.schedule,
      },
      { status: 200 },
    );
  };
}

async function handleDetail(request: NextRequest): Promise<Response> {
  return createAgreementDetailHandler(getAuthService(), getAgreementService())(request);
}

export const GET = withErrorHandling("agreement_detail", handleDetail);
