import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getPaymentService } from "@/lib/payments/getPaymentService";
import type { PaymentService } from "@/lib/payments/paymentService";
import type { PayoutService } from "@/lib/payouts/payoutService";
import { getPayoutService } from "@/lib/payouts/getPayoutService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accurate creditor payout reporting (SC-08): `payoutStatus` is the `payout_attempt.status` enum only
 * (`pending`/`confirmed`/`failed`/`returned`/`null`) — the authoritative "has the creditor actually
 * been paid out" fact. Never `providerName`/`providerPayoutReference` from the payout side; this route
 * already never returned `providerPaymentId` from the payment side either.
 */
export function createPaymentDetailHandler(authService: AuthService, paymentService: PaymentService, payoutService: Pick<PayoutService, "getPayoutStatus">) {
  return async function handleDetail(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");

    const record = await paymentService.retrievePayment(id, userId);
    const payoutStatus = (await payoutService.getPayoutStatus(record.id))?.status ?? null;
    return NextResponse.json(
      {
        id: record.id,
        status: record.status,
        amountMinorUnits: record.amountMinorUnits,
        currency: record.currency,
        payer: { profileKind: record.payerProfileKind, profileId: record.payerProfileId },
        recipient: { profileKind: record.recipientProfileKind, profileId: record.recipientProfileId },
        agreementId: record.agreementId,
        providerName: record.providerName,
        paymentMethod: record.paymentMethod,
        // R11 (Final Open Issue A): previously never returned to the client at all — PaymentDetail.tsx's
        // manual-retry flow silently dropped this, producing an unlinked payment against a scheduled
        // agreement's own already-linked installment. See PaymentDetail.tsx's handleManualPay.
        installmentScheduleItemId: record.installmentScheduleItemId,
        recordedByUserId: record.recordedByUserId,
        recipientConfirmedAt: record.recipientConfirmedAt,
        failureReason: record.failureReason,
        payoutStatus,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      { status: 200 },
    );
  };
}

async function handleDetail(request: NextRequest): Promise<Response> {
  return createPaymentDetailHandler(getAuthService(), getPaymentService(), getPayoutService())(request);
}

export const GET = withErrorHandling("payment_detail", handleDetail);
