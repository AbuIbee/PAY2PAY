import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { draftTermsSchema } from "@/lib/agreements/validation";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { B2BWorkflowService } from "@/lib/b2b/b2bWorkflowService";
import { getB2BWorkflowService } from "@/lib/b2b/getB2BWorkflowService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const businessRefSchema = z.object({ kind: z.literal("business"), id: z.string().uuid() });
const referenceSchema = z.object({
  referenceType: z.enum(["invoice", "purchase_order", "contract"]),
  referenceNumber: z.string().trim().min(1).max(200),
});

const createB2BSchema = draftTermsSchema.extend({
  creditor: businessRefSchema,
  debtor: businessRefSchema,
  currency: z.string().length(3).optional(),
  references: z.array(referenceSchema).max(20).optional(),
});

/** "Both parties must use verified business profiles" — B2BWorkflowService enforces this before ever calling AgreementService.createDraft. */
export function createB2BDraftHandler(authService: AuthService, b2bWorkflowService: B2BWorkflowService) {
  return async function handleCreate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = createB2BSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid B2B agreement draft is required.");
    }

    const result = await b2bWorkflowService.createB2BDraft({ creatorUserId: userId, ...parsed.data });
    return NextResponse.json(
      { id: result.agreement.id, status: result.agreement.status, version: { id: result.version.id, terms: result.version.terms } },
      { status: 201 },
    );
  };
}

async function handleCreate(request: NextRequest): Promise<Response> {
  return createB2BDraftHandler(getAuthService(), getB2BWorkflowService())(request);
}

export const POST = withErrorHandling("b2b_draft_create", handleCreate);
