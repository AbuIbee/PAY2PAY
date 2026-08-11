import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { EvidenceService } from "@/lib/evidence/evidenceService";
import { getEvidenceService } from "@/lib/evidence/getEvidenceService";
import { ValidationError } from "@/lib/errors";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uploadFieldsSchema = z.object({
  agreementId: z.string().uuid(),
  documentType: z.enum([
    "invoice",
    "receipt",
    "contract",
    "estimate",
    "purchase_order",
    "proof_of_delivery",
    "proof_of_completed_work",
    "prior_payment_record",
    "other",
  ]),
  description: z.string().trim().max(2000).optional(),
  visibility: z.enum(["shared", "private"]).default("shared"),
  sharedWithWitnesses: z.enum(["true", "false"]).default("false"),
});

/** multipart/form-data upload — Next.js Route Handlers parse this natively via request.formData(), no extra dependency needed. */
export function createEvidenceUploadHandler(authService: AuthService, evidenceService: EvidenceService) {
  return async function handleUpload(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const formData = await request.formData().catch(() => null);
    if (!formData) throw new ValidationError("A multipart form with a file is required.");

    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new ValidationError("A file is required.");
    }

    const parsed = uploadFieldsSchema.safeParse({
      agreementId: formData.get("agreementId"),
      documentType: formData.get("documentType"),
      description: formData.get("description") ?? undefined,
      visibility: formData.get("visibility") ?? undefined,
      sharedWithWitnesses: formData.get("sharedWithWitnesses") ?? undefined,
    });
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid evidence upload is required.");
    }

    const content = new Uint8Array(await file.arrayBuffer());
    const record = await evidenceService.uploadEvidence({
      agreementId: parsed.data.agreementId,
      actingUserId: userId,
      documentType: parsed.data.documentType,
      description: parsed.data.description ?? null,
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      content,
      visibility: parsed.data.visibility,
      sharedWithWitnesses: parsed.data.sharedWithWitnesses === "true",
      ipAddress: getClientIp(request),
      deviceInfo: null,
    });

    return NextResponse.json(
      {
        id: record.id,
        documentType: record.documentType,
        isPostSigning: record.isPostSigning,
        visibility: record.visibility,
        sharedWithWitnesses: record.sharedWithWitnesses,
        uploadedAt: record.uploadedAt,
      },
      { status: 201 },
    );
  };
}

export function createEvidenceListHandler(authService: AuthService, evidenceService: EvidenceService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");

    const items = await evidenceService.listEvidence(agreementId, userId);
    return NextResponse.json(
      {
        evidence: items.map((item) => ({
          id: item.id,
          uploadedByUserId: item.uploadedByUserId,
          documentType: item.documentType,
          description: item.description,
          fileSizeBytes: item.fileSizeBytes,
          contentType: item.contentType,
          isPostSigning: item.isPostSigning,
          visibility: item.visibility,
          sharedWithWitnesses: item.sharedWithWitnesses,
          disputeFlag: item.disputeFlag,
          withdrawalState: item.withdrawalState,
          uploadedAt: item.uploadedAt,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleUpload(request: NextRequest): Promise<Response> {
  return createEvidenceUploadHandler(getAuthService(), getEvidenceService())(request);
}

async function handleList(request: NextRequest): Promise<Response> {
  return createEvidenceListHandler(getAuthService(), getEvidenceService())(request);
}

export const POST = withErrorHandling("evidence_upload", handleUpload);
export const GET = withErrorHandling("evidence_list", handleList);
