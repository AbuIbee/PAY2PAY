import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { CsvImportService } from "@/lib/csvImport/csvImportService";
import { getCsvImportService } from "@/lib/csvImport/getCsvImportService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createDraftsSchema = z.object({ batchId: z.string().uuid() });

/**
 * CREATE DRAFTS — never a bulk-activation endpoint. Every row that qualifies becomes one
 * `draft`-status agreement via the unchanged Sprint 5 `AgreementService.createDraft`; nothing here
 * submits, acknowledges, or signs anything on any debtor's behalf.
 */
export function createCsvImportCreateDraftsHandler(authService: AuthService, csvImportService: CsvImportService) {
  return async function handleCreateDrafts(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = createDraftsSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("batchId is required.");

    const result = await csvImportService.createDrafts(parsed.data.batchId, userId);
    return NextResponse.json(result, { status: 200 });
  };
}

async function handleCreateDrafts(request: NextRequest): Promise<Response> {
  return createCsvImportCreateDraftsHandler(getAuthService(), getCsvImportService())(request);
}

export const POST = withErrorHandling("csv_import_create_drafts", handleCreateDrafts);
