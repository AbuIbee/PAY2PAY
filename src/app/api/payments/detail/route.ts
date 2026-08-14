import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getPaymentService } from "@/lib/payments/getPaymentService";
import type { PaymentService } from "@/lib/payments/paymentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createPaymentDetailHandler(authService: AuthService, paymentService: PaymentService) {
  return async function handleDetail(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");

    const record = await paymentService.retrievePayment(id, userId);
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
        failureReason: record.failureReason,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      { status: 200 },
    );
  };
}

async function handleDetail(request: NextRequest): Promise<Response> {
  return createPaymentDetailHandler(getAuthService(), getPaymentService())(request);
}

export const GET = withErrorHandling("payment_detail", handleDetail);
