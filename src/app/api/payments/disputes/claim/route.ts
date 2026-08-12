import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { PaymentDisputeService } from "@/lib/disputes/paymentDisputeService";
import { getPaymentDisputeService } from "@/lib/disputes/getPaymentDisputeService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getClientIp } from "@/lib/request-ip";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const claimSchema = z.object({
  paymentAttemptId: z.string().uuid(),
  category: z.enum(["unauthorized_ach", "unauthorized_debit_card", "processor_dispute"]),
  explanation: z.string().trim().min(1).max(4000),
});

/** Only the payer may claim a payment as unauthorized (PaymentDisputeService.claimUnauthorizedPayment enforces this). Preserves mandate/signature/identity-verification references plus IP/device/timestamp at claim time. */
export function createPaymentDisputeClaimHandler(authService: AuthService, paymentDisputeService: PaymentDisputeService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = claimSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid unauthorized-payment claim is required.");
    }
    const record = await paymentDisputeService.claimUnauthorizedPayment({
      ...parsed.data,
      actingUserId: userId,
      ipAddress: getClientIp(request),
      deviceInfo: { userAgent: request.headers.get("user-agent") },
    });
    return NextResponse.json(record, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createPaymentDisputeClaimHandler(getAuthService(), getPaymentDisputeService())(request);
}

export const POST = withErrorHandling("payment_dispute_claim", handlePost);
