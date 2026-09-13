import "server-only";
import { getDb } from "@/db/client";
import { computeInstallmentSettlementWithinTx } from "@/lib/ledger/installmentSettlementTx";
import type { AgreementInstallmentSettlementReader } from "./agreementProgressService";

/**
 * R11 (PARTIAL PAYMENT UX, §7): real implementation of `AgreementInstallmentSettlementReader` — the
 * authoritative REMAINING amount for one installment, computed fresh from ledger truth via the same
 * `computeInstallmentSettlementWithinTx` arithmetic every other R11 call site reuses. Unlocked
 * (read-only display use only — mirrors `DrizzleAgreementInstallmentSatisfactionReader`'s identical
 * unlocked-read precedent); the authoritative, LOCKED enforcement point is the payment-initiation
 * ceiling (`InstallmentPaymentReserver`), not this reader.
 */
export class DrizzleAgreementInstallmentSettlementReader implements AgreementInstallmentSettlementReader {
  async getRemainingMinorUnits(installmentScheduleItemId: string, faceAmountMinorUnits: number): Promise<number> {
    const db = getDb();
    const settlement = await db.transaction((tx) => computeInstallmentSettlementWithinTx(tx, installmentScheduleItemId));
    return settlement ? settlement.remainingMinorUnits : faceAmountMinorUnits;
  }
}
