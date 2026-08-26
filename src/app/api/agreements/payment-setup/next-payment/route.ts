import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { AgreementInstallmentStatusReader } from "@/lib/agreements/agreementProgressService";
import { DrizzleAgreementInstallmentStatusReader } from "@/lib/agreements/drizzleAgreementInstallmentStatusReader";
import type { BalanceService } from "@/lib/ledger/balanceService";
import { getBalanceService } from "@/lib/ledger/getBalanceService";
import type { RelationshipFinancialAccountService } from "@/lib/relationships/relationshipFinancialAccountService";
import { getRelationshipFinancialAccountService } from "@/lib/relationships/getRelationshipFinancialAccountService";
import type { ProfileDisplayReader } from "@/lib/documents/profileDisplayReader";
import { DrizzleProfileDisplayReader } from "@/lib/documents/drizzleProfileDisplayReader";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Restore agreement payment functionality: the structured data the "Make Payment" section on the
 * agreement detail page needs — the next unpaid installment, the current remaining balance, and (for
 * the debtor only) a masked label for their already-connected funding account. Deliberately never
 * returns a raw provider account reference — only a display label — matching this codebase's
 * established "the browser never sees a bank token" invariant.
 *
 * Fix the "Make payment" button (mandatory command): also returns `recipientDisplayName` (for the
 * debtor, the creditor's best-effort display name via the existing ProfileDisplayReader — the same
 * reader already used for PDF/evidence records — never a new lookup service) so the debtor's payment
 * review step can show who they're paying, not just an amount and a due date.
 */
export function createAgreementNextPaymentHandler(
  authService: AuthService,
  agreementService: AgreementService,
  installments: AgreementInstallmentStatusReader,
  balance: BalanceService,
  relationshipAccounts: RelationshipFinancialAccountService,
  profileDisplay: ProfileDisplayReader,
) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");

    const { agreement } = await agreementService.getAgreement(id, userId);
    const myRole = await agreementService.resolvePartyRole(id, userId);

    const items = await installments.listForAgreement(id);
    const nextUnpaid = items.find((i) => i.status !== "paid" && i.status !== "waived") ?? null;

    let remainingBalanceMinorUnits: number | null = null;
    try {
      remainingBalanceMinorUnits = (await balance.getAgreementBalance(id)).remainingBalanceMinorUnits;
    } catch {
      // Not yet computable (e.g. no signed version) — omit rather than fail the whole read.
    }

    let fundingAccountLabel: string | null = null;
    if (myRole === "debtor" && agreement.relationshipId) {
      try {
        const assignments = await relationshipAccounts.getRelationshipAccounts(agreement.relationshipId, userId);
        const funding = assignments.find((a) => a.usage === "funding" && a.status === "active" && a.financialAccount.status !== "disabled");
        if (funding) {
          const account = funding.financialAccount;
          fundingAccountLabel = `${account.institutionDisplayName ?? "Account"} ····${account.maskedLast4 ?? ""}`;
        }
      } catch {
        // Not resolvable — omit rather than fail the whole read.
      }
    }

    let recipientDisplayName: string | null = null;
    if (myRole === "debtor") {
      try {
        recipientDisplayName = await profileDisplay.getDisplayName(agreement.creditorProfileKind, agreement.creditorProfileId);
      } catch {
        // Best-effort only — omit rather than fail the whole read.
      }
    }

    return NextResponse.json(
      {
        nextInstallment: nextUnpaid
          ? { id: nextUnpaid.id, sequenceNumber: nextUnpaid.sequenceNumber, dueDate: nextUnpaid.dueDate, amountMinorUnits: nextUnpaid.amountMinorUnits }
          : null,
        remainingBalanceMinorUnits,
        fundingAccountLabel,
        recipientDisplayName,
      },
      { status: 200 },
    );
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createAgreementNextPaymentHandler(
    getAuthService(),
    getAgreementService(),
    new DrizzleAgreementInstallmentStatusReader(),
    getBalanceService(),
    getRelationshipFinancialAccountService(),
    new DrizzleProfileDisplayReader(),
  )(request);
}

export const GET = withErrorHandling("agreement_payment_setup_next_payment", handleGet);
