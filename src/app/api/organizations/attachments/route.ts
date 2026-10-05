import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { ORGANIZATION_DOCUMENT_TYPES } from "@/lib/organizations/organizationDocumentRepository";
import type { AttachmentParent, BusinessAttachmentService } from "@/lib/organizations/businessAttachmentService";
import { getBusinessAttachmentService } from "@/lib/organizations/getBusinessAttachmentService";
import type { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const parentKindSchema = z.enum(["agreement", "customer", "obligation", "none"]);

const uploadFieldsSchema = z.object({
  organizationId: z.string().uuid(),
  documentType: z.enum(ORGANIZATION_DOCUMENT_TYPES),
  parentKind: parentKindSchema,
  parentId: z.string().uuid().optional(),
});

function toParent(parentKind: z.infer<typeof parentKindSchema>, parentId: string | undefined): AttachmentParent {
  if (parentKind === "none") return { kind: "none" };
  if (!parentId) throw new ValidationError("parentId is required for this attachment type.");
  return { kind: parentKind, id: parentId };
}

/** multipart/form-data upload — mirrors createEvidenceUploadHandler's own established Next.js Route Handler pattern. */
export function createAttachmentUploadHandler(authService: AuthService, attachments: BusinessAttachmentService) {
  return async function handleUpload(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const formData = await request.formData().catch(() => null);
    if (!formData) throw new ValidationError("A multipart form with a file is required.");

    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new ValidationError("A file is required.");
    }

    const parsed = uploadFieldsSchema.safeParse({
      organizationId: formData.get("organizationId"),
      documentType: formData.get("documentType"),
      parentKind: formData.get("parentKind") ?? "none",
      parentId: formData.get("parentId") ?? undefined,
    });
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid attachment upload is required.");
    }

    const content = new Uint8Array(await file.arrayBuffer());
    const record = await attachments.uploadAttachment({
      actingUserId: userId,
      organizationId: parsed.data.organizationId,
      documentType: parsed.data.documentType,
      parent: toParent(parsed.data.parentKind, parsed.data.parentId),
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      content,
    });

    return NextResponse.json(
      {
        id: record.id,
        documentType: record.documentType,
        fileName: record.fileName,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        uploadedByUserId: record.uploadedByUserId,
        createdAt: record.createdAt,
      },
      { status: 201 },
    );
  };
}

const listQuerySchema = z.object({
  organizationId: z.string().uuid(),
  parentKind: parentKindSchema.default("none"),
  parentId: z.string().uuid().optional(),
});

export function createAttachmentListHandler(authService: AuthService, attachments: BusinessAttachmentService, permissions: OrganizationPermissionService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse({
      organizationId: url.searchParams.get("organizationId"),
      parentKind: url.searchParams.get("parentKind") ?? undefined,
      parentId: url.searchParams.get("parentId") ?? undefined,
    });
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "organizationId is required.");
    }

    const items = await attachments.listAttachments({
      actingUserId: userId,
      organizationId: parsed.data.organizationId,
      parent: toParent(parsed.data.parentKind, parsed.data.parentId),
    });
    // Reaching this point already proves "documents.view" — a SEPARATE, non-throwing check for
    // "documents.upload" lets the UI show/hide the upload form without the client ever needing to
    // probe by attempting (and failing) a real upload. Section 15/16/17's own "if user has
    // documents.upload, show Upload Attachment" requirement.
    const canUpload = await permissions.can(userId, parsed.data.organizationId, "documents.upload");

    return NextResponse.json(
      {
        canUpload,
        items: items.map((item) => ({
          id: item.id,
          documentType: item.documentType,
          fileName: item.fileName,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          uploadedByUserId: item.uploadedByUserId,
          status: item.status,
          createdAt: item.createdAt,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleUpload(request: NextRequest): Promise<Response> {
  return createAttachmentUploadHandler(getAuthService(), getBusinessAttachmentService())(request);
}

async function handleList(request: NextRequest): Promise<Response> {
  return createAttachmentListHandler(getAuthService(), getBusinessAttachmentService(), getOrganizationPermissionService())(request);
}

export const POST = withErrorHandling("organizations_attachments_upload", handleUpload);
export const GET = withErrorHandling("organizations_attachments_list", handleList);
