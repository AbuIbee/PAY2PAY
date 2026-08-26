import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AmendmentService } from "@/lib/amendments/amendmentService";
import { getAmendmentService } from "@/lib/amendments/getAmendmentService";
import { computeSchedule } from "@/lib/agreements/schedule";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Receiving-party amendment review remediation: the recipient must be able to see the *effective
 * payment schedule* an amendment would produce, not just its raw terms — this is the one piece
 * `AmendmentRecord` doesn't already carry (it stores `terms`/`frequency`, the schedule's inputs, not
 * the computed schedule itself). Read-only and side-effect-free: reuses the exact same
 * `computeSchedule` function `AmendmentService.applyAmendment` calls when the amendment is actually
 * applied, so what's previewed here is guaranteed to match what would really be created — never a
 * separate, potentially-drifting preview computation. Never writes anything; safe to call from a
 * "View revised agreement" action regardless of the amendment's current status.
 */
export function createAmendmentPreviewHandler(authService: AuthService, amendmentService: AmendmentService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");

    const amendment = await amendmentService.getAmendment(id, userId);
    const computed = computeSchedule({
      currentPrincipalMinorUnits: amendment.terms.currentPrincipalMinorUnits,
      firstPaymentMinorUnits: amendment.terms.firstPaymentMinorUnits,
      installmentAmountMinorUnits: amendment.terms.installmentAmountMinorUnits,
      frequency: amendment.frequency,
      firstPaymentDate: amendment.terms.firstPaymentDate,
    });

    return NextResponse.json(
      {
        schedule: computed.items,
        finalPaymentMinorUnits: computed.finalPaymentMinorUnits,
        numberOfInstallments: computed.numberOfInstallments,
      },
      { status: 200 },
    );
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createAmendmentPreviewHandler(getAuthService(), getAmendmentService())(request);
}

export const GET = withErrorHandling("amendment_preview", handleGet);
