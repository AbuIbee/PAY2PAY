import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AchPaymentService } from "@/lib/ach/achPaymentService";
import { getAchPaymentService } from "@/lib/ach/getAchPaymentService";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { PartialPaymentService } from "@/lib/partialPayments/partialPaymentService";
import { getPartialPaymentService } from "@/lib/partialPayments/getPartialPaymentService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const initiatePaymentSchema = z.object({
  partialPaymentRequestId: z.string().uuid(),
});

/**
 * R11 PASS B1 — TARGETED FINAL CORRECTION (Defect B1-A — "PAY $X NOW" INCORRECTLY USES
 * OFF-PLATFORM RECORDING): "Pay $X now" must initiate a REAL, provider-routed payment through the
 * SAME production rail the ordinary "Make a payment" panel uses (`AchPaymentService.createManualPayment`
 * — a "manual" TRIGGER of a real ACH charge, never `PaymentService.recordManualOffPlatformPayment`,
 * which is a record-only path reserved for money that has already moved outside the platform —
 * see `AgreementDetail.tsx`'s own doc comment for the false equivalence this route corrects). No
 * second payment engine: this composes the SAME two already-existing production services
 * (`PartialPaymentService`, `AgreementService`, `AchPaymentService`) every other real payment path
 * already goes through — never a hand-rolled substitute.
 *
 * TRUSTED SERVER-SIDE DERIVATION: the client supplies ONLY `partialPaymentRequestId` — every field
 * that decides WHAT gets charged (`agreementId`, `installmentScheduleItemId`,
 * `proposedAmountMinorUnits`, `payer`/`recipient`) is read from the STORED, accepted request via
 * `PartialPaymentService.getPartialPaymentRequest` (which independently proves the acting user is a
 * real party to that request's own agreement) and `AgreementService.getAgreement` (a second,
 * independent authorization check against the SAME agreement) — never trusted from the request body.
 * `getPartialPaymentRequest`/`resolvePartyRole` throw if the request doesn't exist or the acting user
 * isn't a party to it; this handler additionally requires the acting user be specifically the debtor
 * (only the debtor pays) and the request be `awaiting_payment` (accepted and not yet consumed by an
 * already-applied payment — `PartialPaymentService.recordPayment`'s own status transition away from
 * `awaiting_payment` is what "already consumed" means here).
 *
 * NO DUPLICATE CHARGE ON RE-INITIATION: the idempotency key is DETERMINISTIC, derived solely from the
 * request's own id (`partial-payment-${id}`) — re-invoking this endpoint for the SAME accepted
 * request always resolves to the SAME `payment_attempt` via `PaymentService.reserveAttempt`'s own
 * pre-existing idempotent-replay handling, never a second, independent charge.
 *
 * Every existing R11/Pass A gate applies automatically and unmodified, because this call reaches the
 * REAL production reservation path (`AchPaymentService.createManualPayment` ->
 * `PaymentService.schedulePayment` -> `reserveAttempt` -> the protected `installmentReserver`):
 * agreement/installment ownership + current-schedule validation, the one-unresolved-attempt
 * invariant, the installment ceiling, and idempotency. `payment_cleared` never arises merely from
 * this call returning — the response reflects whatever REAL, non-terminal status the provider
 * dispatch itself produced (e.g. "scheduled"/"submitted"/"processing"); actual clearing happens only
 * later, through the normal provider webhook lifecycle, exactly like every other ACH payment.
 *
 * Durable association with the accepted request (`PartialPaymentService.recordPayment`) is
 * DELIBERATELY NOT called from here — `recordPayment` requires the linked payment to already be
 * `"succeeded"`, which a real, just-initiated ACH payment never is synchronously; calling it here
 * would either always fail or require faking a status this route has no authority to claim.
 * Associating the accepted request with its now-cleared payment remains `recordPayment`'s own
 * existing, unmodified responsibility, exercised at the correct lifecycle point (once the payment has
 * genuinely cleared), never a substitute for actually moving money.
 */
export function createInitiatePartialPaymentHandler(
  authService: AuthService,
  partialPaymentService: PartialPaymentService,
  agreementService: AgreementService,
  achPaymentService: AchPaymentService,
) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = initiatePaymentSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid partialPaymentRequestId is required.");
    }

    // Trusted, server-side lookup — throws unless the acting user is a real party to this request's
    // own agreement (ForbiddenError/ValidationError from PartialPaymentService.getPartialPaymentRequest).
    const partialPaymentRequest = await partialPaymentService.getPartialPaymentRequest(parsed.data.partialPaymentRequestId, userId);
    if (partialPaymentRequest.status !== "awaiting_payment") {
      throw new ValidationError(`This partial payment request is not awaiting payment (status: "${partialPaymentRequest.status}").`);
    }

    const role = await agreementService.resolvePartyRole(partialPaymentRequest.agreementId, userId);
    if (role !== "debtor") {
      throw new ValidationError("Only the borrower may pay a partial payment request.");
    }

    const { agreement } = await agreementService.getAgreement(partialPaymentRequest.agreementId, userId);
    const record = await achPaymentService.createManualPayment({
      idempotencyKey: `partial-payment-${partialPaymentRequest.id}`,
      agreementId: partialPaymentRequest.agreementId,
      payer: { profileKind: agreement.debtorProfileKind, profileId: agreement.debtorProfileId },
      recipient: { profileKind: agreement.creditorProfileKind, profileId: agreement.creditorProfileId },
      amountMinorUnits: partialPaymentRequest.proposedAmountMinorUnits,
      currency: agreement.currency,
      actingUserId: userId,
      installmentScheduleItemId: partialPaymentRequest.installmentScheduleItemId ?? undefined,
    });
    return NextResponse.json({ id: record.id, status: record.status }, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createInitiatePartialPaymentHandler(getAuthService(), getPartialPaymentService(), getAgreementService(), getAchPaymentService())(request);
}

export const POST = withErrorHandling("partial_payment_initiate_payment", handlePost);
