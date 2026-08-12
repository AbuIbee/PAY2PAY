import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementDisputeService } from "@/lib/disputes/agreementDisputeService";
import { getAgreementDisputeService } from "@/lib/disputes/getAgreementDisputeService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const openSchema = z.object({
  agreementId: z.string().uuid(),
  category: z.enum(["debt_does_not_exist", "incorrect_amount", "evidence_challenged", "administration_challenged", "other"]),
  explanation: z.string().trim().min(1).max(4000),
  evidenceIds: z.array(z.string().uuid()).optional(),
});

/** Master spec §13: either party may dispute the debt's existence, amount, evidence, or agreement administration. */
export function createAgreementDisputeOpenHandler(authService: AuthService, agreementDisputeService: AgreementDisputeService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = openSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid dispute is required.");
    }
    const record = await agreementDisputeService.openDispute({ ...parsed.data, actingUserId: userId });
    return NextResponse.json(record, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAgreementDisputeOpenHandler(getAuthService(), getAgreementDisputeService())(request);
}

export const POST = withErrorHandling("agreement_dispute_open", handlePost);
