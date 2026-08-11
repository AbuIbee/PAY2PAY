import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getLedgerAdminService } from "@/lib/ledger/getLedgerAdminService";
import type { LedgerAdminService } from "@/lib/ledger/ledgerAdminService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createAdminLedgerAgreementHandler(authService: AuthService, ledgerAdminService: LedgerAdminService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { platformRole } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");

    const view = await ledgerAdminService.getAgreementLedgerView(platformRole, agreementId);
    return NextResponse.json(view, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createAdminLedgerAgreementHandler(getAuthService(), getLedgerAdminService())(request);
}

export const GET = withErrorHandling("admin_ledger_agreement", handleGet);
