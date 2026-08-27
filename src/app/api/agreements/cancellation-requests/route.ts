import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementCancellationService } from "@/lib/agreements/agreementCancellationService";
import { getAgreementCancellationService } from "@/lib/agreements/getAgreementCancellationService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  agreementId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});

/** Mutual cancellation (mandatory command): "Request Cancellation" on an active agreement — either party may propose it (AgreementCancellationService.requestCancellation enforces the active-status gate and the one-pending-request-at-a-time rule). */
export function createAgreementCancellationRequestHandler(authService: AuthService, cancellationService: AgreementCancellationService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid cancellation request is required.");
    }
    const record = await cancellationService.requestCancellation({
      agreementId: parsed.data.agreementId,
      reason: parsed.data.reason,
      actingUserId: userId,
    });
    return NextResponse.json(record, { status: 201 });
  };
}

/** GET ?agreementId= — thin route over AgreementCancellationService.listCancellationRequests. */
export function createAgreementCancellationListHandler(authService: AuthService, cancellationService: AgreementCancellationService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");
    const requests = await cancellationService.listCancellationRequests(agreementId, userId);
    return NextResponse.json({ requests }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAgreementCancellationRequestHandler(getAuthService(), getAgreementCancellationService())(request);
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createAgreementCancellationListHandler(getAuthService(), getAgreementCancellationService())(request);
}

export const POST = withErrorHandling("agreement_cancellation_request", handlePost);
export const GET = withErrorHandling("agreement_cancellation_list", handleGet);
