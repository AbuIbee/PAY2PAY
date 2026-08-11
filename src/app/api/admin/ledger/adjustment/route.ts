import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getLedgerAdminService } from "@/lib/ledger/getLedgerAdminService";
import type { LedgerAdminService } from "@/lib/ledger/ledgerAdminService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCOUNT_TYPES = [
  "processor_clearing",
  "creditor_proceeds_payable",
  "platform_fee_revenue",
  "processor_fee_expense",
  "creditor_clawback_exposure",
] as const;

const adjustmentSchema = z.object({
  paymentAttemptId: z.string().uuid(),
  agreementId: z.string().uuid(),
  currency: z.string().trim().length(3),
  targetAccountType: z.enum(ACCOUNT_TYPES),
  direction: z.enum(["debit", "credit"]),
  amountMinorUnits: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
});

/** Sprint 10: Platform Owner only — see LedgerAdminService's doc comment for why this is gated more strictly than the rest of this file's read-only surface. */
export function createAdminLedgerAdjustmentHandler(authService: AuthService, ledgerAdminService: LedgerAdminService) {
  return async function handleAdjustment(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = adjustmentSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid adjustment request is required.");
    }

    const entry = await ledgerAdminService.postAdjustment(platformRole, userId, parsed.data);
    return NextResponse.json(entry, { status: 201 });
  };
}

async function handleAdjustment(request: NextRequest): Promise<Response> {
  return createAdminLedgerAdjustmentHandler(getAuthService(), getLedgerAdminService())(request);
}

export const POST = withErrorHandling("admin_ledger_adjustment", handleAdjustment);
