import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getLedgerAdminService } from "@/lib/ledger/getLedgerAdminService";
import type { LedgerAdminService } from "@/lib/ledger/ledgerAdminService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sprint 10: manually triggers a full reconciliation pass. Safe to call repeatedly — ReconciliationService.reconcileAll is idempotent (requirement #10). */
export function createAdminLedgerReconcileHandler(authService: AuthService, ledgerAdminService: LedgerAdminService) {
  return async function handleReconcile(request: NextRequest): Promise<Response> {
    const { platformRole } = await requireSession(request, authService);
    const exceptions = await ledgerAdminService.runReconciliation(platformRole);
    return NextResponse.json({ exceptions }, { status: 200 });
  };
}

async function handleReconcile(request: NextRequest): Promise<Response> {
  return createAdminLedgerReconcileHandler(getAuthService(), getLedgerAdminService())(request);
}

export const POST = withErrorHandling("admin_ledger_reconcile", handleReconcile);
