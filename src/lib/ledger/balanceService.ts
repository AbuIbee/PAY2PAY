import "server-only";
import { ValidationError } from "@/lib/errors";
import type { LedgerJournalEntryRecord, LedgerService } from "./ledgerService";

export type SettlementState = "unpaid" | "partially_paid" | "paid_in_full" | "overpaid";

export interface AgreementBalance {
  agreementId: string;
  currency: string;
  originalPrincipalMinorUnits: number;
  amountPaidMinorUnits: number;
  reversedMinorUnits: number;
  remainingBalanceMinorUnits: number;
  settlementState: SettlementState;
}

/**
 * Sprint 10's read-only window onto Sprint 5's immutable agreement terms — `currentPrincipalMinorUnits`
 * is read directly from `agreement_version.terms` (never duplicated into a ledger table), matching
 * this sprint's requirement #7 ("ledger activity must never rewrite agreement principal, terms").
 */
export interface AgreementTermsReader {
  getPrincipal(agreementId: string): Promise<{ principalMinorUnits: number; currency: string } | null>;
}

/**
 * Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md) requirement #15: deterministic
 * balance reconstruction, entirely from Sprint 5's read-only principal plus `LedgerService`'s
 * journal history — never from a mutable cached balance field (none exists anywhere in this
 * codebase). Requirement #16 ("identical results regardless of read order") is structural here: see
 * `reconstruct`'s doc comment.
 */
export class BalanceService {
  constructor(private readonly deps: { ledger: LedgerService; terms: AgreementTermsReader }) {}

  async getAgreementBalance(agreementId: string): Promise<AgreementBalance> {
    const termsInfo = await this.deps.terms.getPrincipal(agreementId);
    if (!termsInfo) {
      throw new ValidationError("Agreement not found, or has no signed terms to compute a balance against yet.");
    }

    const entries = await this.deps.ledger.listEntriesForAgreement(agreementId);
    const { amountPaidMinorUnits, reversedMinorUnits } = this.reconstruct(entries);
    const remainingBalanceMinorUnits = termsInfo.principalMinorUnits - amountPaidMinorUnits;

    let settlementState: SettlementState;
    if (amountPaidMinorUnits <= 0) settlementState = "unpaid";
    else if (amountPaidMinorUnits < termsInfo.principalMinorUnits) settlementState = "partially_paid";
    else if (amountPaidMinorUnits === termsInfo.principalMinorUnits) settlementState = "paid_in_full";
    else settlementState = "overpaid";

    return {
      agreementId,
      currency: termsInfo.currency,
      originalPrincipalMinorUnits: termsInfo.principalMinorUnits,
      amountPaidMinorUnits,
      reversedMinorUnits,
      remainingBalanceMinorUnits,
      settlementState,
    };
  }

  /**
   * Groups entries by payment attempt, then sums each payment's gross-cleared amount into either
   * "paid" (cleared, never reversed) or "reversed" (cleared, then refunded/reversed/disputed —
   * whether the reversal used the pre-payout mirror shape or the post-payout clawback shape, the
   * debtor's obligation is treated as unsatisfied either way: docs/PAYMENT_ARCHITECTURE.md §7's
   * "reduce the agreement's recorded paid balance" applies to a late return regardless of whether
   * payout already occurred — only *who bears the clawback exposure* differs, not whether the
   * debtor's payment still counts). Each payment's contribution is computed independently of every
   * other payment and independently of iteration order, so summing in any order — or shuffling the
   * input array first — produces the identical total; see balanceService.test.ts.
   */
  private reconstruct(entries: LedgerJournalEntryRecord[]): { amountPaidMinorUnits: number; reversedMinorUnits: number } {
    const byPayment = new Map<string, LedgerJournalEntryRecord[]>();
    for (const entry of entries) {
      const list = byPayment.get(entry.paymentAttemptId) ?? [];
      list.push(entry);
      byPayment.set(entry.paymentAttemptId, list);
    }

    let amountPaidMinorUnits = 0;
    let reversedMinorUnits = 0;
    for (const paymentEntries of byPayment.values()) {
      const clearEntry = paymentEntries.find((e) => e.entryType === "payment_cleared");
      if (!clearEntry) continue;
      const grossLeg = clearEntry.postings.find((p) => p.accountType === "processor_clearing" && p.direction === "debit");
      if (!grossLeg) continue;
      const wasReversed = paymentEntries.some(
        (e) => e.entryType === "refund" || e.entryType === "reversal" || e.entryType === "dispute_adjustment",
      );
      if (wasReversed) reversedMinorUnits += grossLeg.amountMinorUnits;
      else amountPaidMinorUnits += grossLeg.amountMinorUnits;
    }
    return { amountPaidMinorUnits, reversedMinorUnits };
  }
}
