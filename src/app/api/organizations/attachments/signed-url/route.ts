import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { BusinessAttachmentService } from "@/lib/organizations/businessAttachmentService";
import { getBusinessAttachmentService } from "@/lib/organizations/getBusinessAttachmentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  organizationId: z.string().uuid(),
  attachmentId: z.string().uuid(),
});

/**
 * Mirrors `/api/agreements/pdf`'s own established "GET returns a short-lived signed URL, never a
 * redirect to a persisted one" pattern. Cross-tenant requests are denied by
 * `BusinessAttachmentService.getSignedDownloadUrl`'s own `findByIdForOrganization` check BEFORE
 * `DocumentStorage.createSignedUrl` is ever invoked (Section 11).
 */
export function createAttachmentSignedUrlHandler(authService: AuthService, attachments: BusinessAttachmentService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      organizationId: url.searchParams.get("organizationId"),
      attachmentId: url.searchParams.get("attachmentId"),
    });
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "organizationId and attachmentId are required.");
    }

    const result = await attachments.getSignedDownloadUrl({
      actingUserId: userId,
      organizationId: parsed.data.organizationId,
      attachmentId: parsed.data.attachmentId,
    });

    return NextResponse.json(
      {
        url: result.url,
        expiresInSeconds: result.expiresInSeconds,
        fileName: result.attachment.fileName,
      },
      { status: 200 },
    );
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createAttachmentSignedUrlHandler(getAuthService(), getBusinessAttachmentService())(request);
}

export const GET = withErrorHandling("organizations_attachments_signed_url", handleGet);
