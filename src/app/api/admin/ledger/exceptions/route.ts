import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getLedgerAdminService } from "@/lib/ledger/getLedgerAdminService";
import type { LedgerAdminService } from "@/lib/ledger/ledgerAdminService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createAdminLedgerExceptionsHandler(authService: AuthService, ledgerAdminService: LedgerAdminService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { platformRole } = await requireSession(request, authService);
    const exceptions = await ledgerAdminService.listOpenExceptions(platformRole);
    return NextResponse.json({ exceptions }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createAdminLedgerExceptionsHandler(getAuthService(), getLedgerAdminService())(request);
}

export const GET = withErrorHandling("admin_ledger_exceptions", handleGet);
