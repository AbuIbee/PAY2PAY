import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AppealService } from "@/lib/admin/appealService";
import { getAppealService } from "@/lib/admin/getAppealService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ledgerAdjustmentSchema = z.object({
  paymentAttemptId: z.string().uuid(),
  agreementId: z.string().uuid(),
  currency: z.string().trim().length(3),
  targetAccountType: z.enum(["processor_clearing", "creditor_proceeds_payable", "platform_fee_revenue", "processor_fee_expense", "creditor_clawback_exposure"]),
  direction: z.enum(["debit", "credit"]),
  amountMinorUnits: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
});

const decideSchema = z.object({
  appealId: z.string().uuid(),
  decision: z.enum(["upheld", "overturned", "partially_overturned"]),
  rationale: z.string().trim().min(1).max(4000),
  liftRestrictionId: z.string().uuid().optional(),
  ledgerAdjustment: ledgerAdjustmentSchema.optional(),
});

/**
 * Requires "manage_appeal" and that the caller is this specific appeal's assigned reviewer — enforced
 * inside AppealService.decideAppeal itself. `ledgerAdjustment`, if given, is passed straight through to
 * Sprint 10's existing `LedgerAdminService.postAdjustment` — that service's own Platform-Owner-only
 * gate applies unchanged; a non-Owner reviewer deciding an appeal with a ledger adjustment attached
 * will have the decision recorded but the adjustment itself rejected.
 */
export function createAppealDecideHandler(authService: AuthService, appealService: AppealService) {
  return async function handleDecide(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = decideSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid appeal decision payload is required.");
    }
    const appeal = await appealService.decideAppeal({
      appealId: parsed.data.appealId,
      decision: parsed.data.decision,
      rationale: parsed.data.rationale,
      liftRestrictionId: parsed.data.liftRestrictionId,
      ledgerAdjustment: parsed.data.ledgerAdjustment,
      actingUserId: userId,
      actingRole: platformRole,
    });
    return NextResponse.json({ appeal }, { status: 200 });
  };
}

async function handleDecide(request: NextRequest): Promise<Response> {
  return createAppealDecideHandler(getAuthService(), getAppealService())(request);
}

export const POST = withErrorHandling("appeal_decide", handleDecide);
