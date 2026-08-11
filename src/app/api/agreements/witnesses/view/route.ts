import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { WitnessService } from "@/lib/evidence/witnessService";
import { getWitnessService } from "@/lib/evidence/getWitnessService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A witness's own read-only view — never routes through AgreementService's party-only authorization (see WitnessService.getWitnessView's doc comment). */
export function createWitnessViewHandler(authService: AuthService, witnessService: WitnessService) {
  return async function handleView(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");

    const view = await witnessService.getWitnessView(agreementId, userId);
    return NextResponse.json(
      {
        agreement: { id: view.agreement.id, status: view.agreement.status, currency: view.agreement.currency },
        version: {
          id: view.version.id,
          versionNumber: view.version.versionNumber,
          terms: view.version.terms,
          signedAt: view.version.signedAt,
        },
        schedule: view.schedule,
      },
      { status: 200 },
    );
  };
}

async function handleView(request: NextRequest): Promise<Response> {
  return createWitnessViewHandler(getAuthService(), getWitnessService())(request);
}

export const GET = withErrorHandling("witness_view", handleView);
