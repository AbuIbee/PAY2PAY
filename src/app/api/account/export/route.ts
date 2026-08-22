import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { DataExportService } from "@/lib/compliance/dataExportService";
import { getDataExportService } from "@/lib/compliance/getDataExportService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PRSprint 32 (docs/prsprints/PRSPRINT_32_COMPLIANCE_HOOKS_CONSENT_PRIVACY_RETENTION.md): master-spec
 * item 117, "Add user data export where appropriate." Always the *caller's own* data — userId comes
 * from the session, never a request parameter, so there is no cross-user export path to authorize
 * against.
 */
export function createAccountExportHandler(authService: AuthService, dataExport: DataExportService) {
  return async function handleExport(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const data = await dataExport.exportForUser(userId);
    return NextResponse.json(data, { status: 200 });
  };
}

async function handleExport(request: NextRequest): Promise<Response> {
  return createAccountExportHandler(getAuthService(), getDataExportService())(request);
}

export const GET = withErrorHandling("account_export", handleExport);
