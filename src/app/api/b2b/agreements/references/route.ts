import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { B2BWorkflowService } from "@/lib/b2b/b2bWorkflowService";
import { getB2BWorkflowService } from "@/lib/b2b/getB2BWorkflowService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addSchema = z.object({
  agreementId: z.string().uuid(),
  referenceType: z.enum(["invoice", "purchase_order", "contract"]),
  referenceNumber: z.string().trim().min(1).max(200),
});

export function createB2BAddReferenceHandler(authService: AuthService, b2bWorkflowService: B2BWorkflowService) {
  return async function handleAdd(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = addSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid reference is required.");
    }
    const record = await b2bWorkflowService.addReference({
      agreementId: parsed.data.agreementId,
      actingUserId: userId,
      referenceType: parsed.data.referenceType,
      referenceNumber: parsed.data.referenceNumber,
    });
    return NextResponse.json({ id: record.id }, { status: 201 });
  };
}

export function createB2BListReferencesHandler(authService: AuthService, b2bWorkflowService: B2BWorkflowService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");

    const references = await b2bWorkflowService.listReferences(agreementId, userId);
    return NextResponse.json(
      { references: references.map((r) => ({ id: r.id, referenceType: r.referenceType, referenceNumber: r.referenceNumber, addedAt: r.addedAt })) },
      { status: 200 },
    );
  };
}

async function handleAdd(request: NextRequest): Promise<Response> {
  return createB2BAddReferenceHandler(getAuthService(), getB2BWorkflowService())(request);
}

async function handleList(request: NextRequest): Promise<Response> {
  return createB2BListReferencesHandler(getAuthService(), getB2BWorkflowService())(request);
}

export const POST = withErrorHandling("b2b_reference_add", handleAdd);
export const GET = withErrorHandling("b2b_reference_list", handleList);
