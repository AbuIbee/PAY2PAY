import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { CsvImportService } from "@/lib/csvImport/csvImportService";
import { getCsvImportService } from "@/lib/csvImport/getCsvImportService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createCsvImportPreviewHandler(authService: AuthService, csvImportService: CsvImportService) {
  return async function handlePreview(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const batchId = new URL(request.url).searchParams.get("batchId");
    if (!batchId) throw new ValidationError("batchId is required.");

    const result = await csvImportService.getPreview(batchId, userId);
    return NextResponse.json(
      {
        batch: { id: result.batch.id, status: result.batch.status, fileName: result.batch.fileName },
        rows: result.rows.map((row) => ({
          id: row.id,
          rowNumber: row.rowNumber,
          customerEmail: row.customerEmail,
          customerName: row.customerName,
          invoiceReference: row.invoiceReference,
          balanceMinorUnits: row.balanceMinorUnits,
          proposedInstallmentAmountMinorUnits: row.proposedInstallmentAmountMinorUnits,
          proposedFrequency: row.proposedFrequency,
          proposedFirstPaymentDate: row.proposedFirstPaymentDate,
          validationStatus: row.validationStatus,
          validationErrors: row.validationErrors,
          duplicateStatus: row.duplicateStatus,
          createdDraftAgreementId: row.createdDraftAgreementId,
        })),
      },
      { status: 200 },
    );
  };
}

async function handlePreview(request: NextRequest): Promise<Response> {
  return createCsvImportPreviewHandler(getAuthService(), getCsvImportService())(request);
}

export const GET = withErrorHandling("csv_import_preview", handlePreview);
