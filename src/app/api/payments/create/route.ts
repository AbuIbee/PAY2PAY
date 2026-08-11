import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getClientIp } from "@/lib/request-ip";
import { getPaymentService } from "@/lib/payments/getPaymentService";
import type { PaymentService } from "@/lib/payments/paymentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const profileRefSchema = z.object({
  profileKind: z.enum(["personal", "business"]),
  profileId: z.string().uuid(),
});

const createPaymentSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  payer: profileRefSchema,
  recipient: profileRefSchema,
  amountMinorUnits: z.number().int().positive(),
  currency: z.string().trim().length(3).default("USD"),
  agreementId: z.string().uuid().optional(),
  deviceInfo: z.unknown().optional(),
});

/**
 * Sprint 9: PaymentService.createPayment itself enforces that the caller owns the payer profile
 * (a payment is always initiated by the party paying) and the payer/recipient full-verification
 * gate — this route is a thin, unauthenticated-input-validating wrapper only.
 */
export function createPaymentCreateHandler(authService: AuthService, paymentService: PaymentService) {
  return async function handleCreate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = createPaymentSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid payment request is required.");
    }

    const record = await paymentService.createPayment({
      idempotencyKey: parsed.data.idempotencyKey,
      payer: parsed.data.payer,
      recipient: parsed.data.recipient,
      amountMinorUnits: parsed.data.amountMinorUnits,
      currency: parsed.data.currency,
      agreementId: parsed.data.agreementId ?? null,
      actingUserId: userId,
      ipAddress: getClientIp(request),
      deviceInfo: parsed.data.deviceInfo ?? null,
    });
    return NextResponse.json(
      { id: record.id, status: record.status, providerName: record.providerName },
      { status: 201 },
    );
  };
}

async function handleCreate(request: NextRequest): Promise<Response> {
  return createPaymentCreateHandler(getAuthService(), getPaymentService())(request);
}

export const POST = withErrorHandling("payment_create", handleCreate);
