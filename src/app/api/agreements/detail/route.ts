import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { resolveAgreementPartyDisplays, type PartyDisplayReader, type PartySnapshotReader } from "@/lib/agreements/agreementPartyDisplay";
import { getAgreementIdentitySnapshotService } from "@/lib/agreements/getAgreementIdentitySnapshotService";
import { DrizzleProfileDisplayReader } from "@/lib/documents/drizzleProfileDisplayReader";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createAgreementDetailHandler(
  authService: AuthService,
  agreementService: AgreementService,
  partySnapshots: PartySnapshotReader,
  profileDisplay: PartyDisplayReader,
) {
  return async function handleDetail(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");

    const result = await agreementService.getAgreement(id, userId);
    // Decision 8: same shared read SignatureService uses for the PDF (resolveAgreementPartyDisplays)
    // — prefers the immutable snapshot once Step 2 has completed, so the on-screen finalized
    // agreement and the generated PDF can never disagree about party identity.
    // `source` ("snapshot" | "legacy_live") is a server-internal signal only — never exposed in the
    // agreement-facing response (see resolveAgreementPartyDisplays's own doc comment).
    const { creditor: creditorDisplay, debtor: debtorDisplay } = await resolveAgreementPartyDisplays(result, { partySnapshots, profileDisplay });
    return NextResponse.json(
      {
        id: result.agreement.id,
        status: result.agreement.status,
        currency: result.agreement.currency,
        relationshipShape: agreementService.relationshipShape(result.agreement),
        // Production defect remediation (existing payment methods must be recognized): the agreement
        // page's own inline "use an existing verified account" panel needs this to call
        // POST /api/relationships/accounts/assign directly — never a second, divergent lookup.
        relationshipId: result.agreement.relationshipId,
        creditor: { kind: result.agreement.creditorProfileKind, id: result.agreement.creditorProfileId },
        debtor: { kind: result.agreement.debtorProfileKind, id: result.agreement.debtorProfileId },
        partyDisplay: { creditor: creditorDisplay, debtor: debtorDisplay },
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
  return createAgreementDetailHandler(
    getAuthService(),
    getAgreementService(),
    getAgreementIdentitySnapshotService(),
    new DrizzleProfileDisplayReader(),
  )(request);
}

export const GET = withErrorHandling("agreement_detail", handleDetail);
