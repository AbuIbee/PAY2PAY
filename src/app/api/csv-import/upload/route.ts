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

const fieldsSchema = z.object({ businessProfileId: z.string().uuid() });

/** multipart/form-data upload — Next.js Route Handlers parse this natively via request.formData(), matching the agreements/evidence upload route's convention. */
export function createCsvImportUploadHandler(authService: AuthService, csvImportService: CsvImportService) {
  return async function handleUpload(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const formData = await request.formData().catch(() => null);
    if (!formData) throw new ValidationError("A multipart form with a file is required.");

    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new ValidationError("A CSV file is required.");
    }
    const parsed = fieldsSchema.safeParse({ businessProfileId: formData.get("businessProfileId") });
    if (!parsed.success) {
      throw new ValidationError("businessProfileId is required.");
    }

    const csvContent = await file.text();
    const result = await csvImportService.uploadBatch({
      businessProfileId: parsed.data.businessProfileId,
      actingUserId: userId,
      fileName: file.name,
      csvContent,
    });
    return NextResponse.json(
      { batchId: result.batch.id, status: result.batch.status, rowCount: result.rows.length },
      { status: 201 },
    );
  };
}

async function handleUpload(request: NextRequest): Promise<Response> {
  return createCsvImportUploadHandler(getAuthService(), getCsvImportService())(request);
}

export const POST = withErrorHandling("csv_import_upload", handleUpload);
