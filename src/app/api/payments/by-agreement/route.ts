import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { PaymentService } from "@/lib/payments/paymentService";
import { getPaymentService } from "@/lib/payments/getPaymentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 18B: thin route for the Payments UI's per-agreement history —
 * PaymentService had no scoped list before this (only findById and an
 * unscoped cron-only listAll). Authorization is agreement-party membership,
 * checked via AgreementService.getAgreement (same authorization every other
 * agreement-scoped route already relies on) before any payment_attempt row
 * is returned.
 */
export function createPaymentsByAgreementHandler(
  authService: AuthService,
  agreementService: AgreementService,
  paymentService: PaymentService,
) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");

    await agreementService.getAgreement(agreementId, userId);
    const payments = await paymentService.listByAgreementId(agreementId);
    return NextResponse.json({ payments }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createPaymentsByAgreementHandler(getAuthService(), getAgreementService(), getPaymentService())(request);
}

export const GET = withErrorHandling("payments_by_agreement", handleList);
