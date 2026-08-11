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

const validateSchema = z.object({ batchId: z.string().uuid() });

export function createCsvImportValidateHandler(authService: AuthService, csvImportService: CsvImportService) {
  return async function handleValidate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = validateSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("batchId is required.");

    const result = await csvImportService.validateBatch(parsed.data.batchId, userId);
    return NextResponse.json(
      {
        batch: { id: result.batch.id, status: result.batch.status },
        rows: result.rows.map((row) => ({
          id: row.id,
          rowNumber: row.rowNumber,
          customerEmail: row.customerEmail,
          validationStatus: row.validationStatus,
          validationErrors: row.validationErrors,
          duplicateStatus: row.duplicateStatus,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleValidate(request: NextRequest): Promise<Response> {
  return createCsvImportValidateHandler(getAuthService(), getCsvImportService())(request);
}

export const POST = withErrorHandling("csv_import_validate", handleValidate);
