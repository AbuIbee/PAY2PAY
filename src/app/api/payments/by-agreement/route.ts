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
import type { PayoutService } from "@/lib/payouts/payoutService";
import { getPayoutService } from "@/lib/payouts/getPayoutService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sprint 18B: thin route for the Payments UI's per-agreement history —
 * PaymentService had no scoped list before this (only findById and an
 * unscoped cron-only listAll). Authorization is agreement-party membership,
 * checked via AgreementService.getAgreement (same authorization every other
 * agreement-scoped route already relies on) before any payment_attempt row
 * is returned.
 *
 * PAID2YOU — B0-D PHASE 3D (payout status accuracy): this response previously serialized the FULL,
 * unfiltered `PaymentAttemptRecord` for every payment — including `providerPaymentId` (the real
 * payment provider's own transaction reference), `idempotencyKey`, `recordedByUserId`,
 * `bankConnectionId`, and the raw `payoutCompletedAt`/`payoutInitiatedAt` timestamps (which, per
 * `payout_attempt`'s own doc comment, are NOT the authoritative source of "was this creditor actually
 * paid" — `payout_attempt.status` is). Now an explicit whitelist, mirroring `/api/payments/detail`'s
 * already-established pattern, and each payment carries its own authoritative `payoutStatus` (the
 * `payout_attempt.status` enum only — never `providerName`/`providerPayoutReference`) instead.
 */
export function createPaymentsByAgreementHandler(
  authService: AuthService,
  agreementService: AgreementService,
  paymentService: PaymentService,
  payoutService: Pick<PayoutService, "getPayoutStatus">,
) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");

    await agreementService.getAgreement(agreementId, userId);
    const payments = await paymentService.listByAgreementId(agreementId);
    const withPayoutStatus = await Promise.all(
      payments.map(async (payment) => ({
        id: payment.id,
        status: payment.status,
        amountMinorUnits: payment.amountMinorUnits,
        currency: payment.currency,
        agreementId: payment.agreementId,
        payerProfileKind: payment.payerProfileKind,
        payerProfileId: payment.payerProfileId,
        recipientProfileKind: payment.recipientProfileKind,
        recipientProfileId: payment.recipientProfileId,
        installmentScheduleItemId: payment.installmentScheduleItemId,
        paymentMethod: payment.paymentMethod,
        createdAt: payment.createdAt,
        payoutStatus: (await payoutService.getPayoutStatus(payment.id))?.status ?? null,
      })),
    );
    return NextResponse.json({ payments: withPayoutStatus }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createPaymentsByAgreementHandler(getAuthService(), getAgreementService(), getPaymentService(), getPayoutService())(request);
}

export const GET = withErrorHandling("payments_by_agreement", handleList);
