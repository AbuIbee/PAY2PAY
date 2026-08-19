import "server-only";
import { getAchMandateService } from "@/lib/ach/getAchMandateService";
import { getDebitCardMethodService } from "@/lib/debitCard/getDebitCardMethodService";
import { getPaymentService } from "@/lib/payments/getPaymentService";
import { getBalanceService } from "./getBalanceService";
import { getLedgerService } from "./getLedgerService";
import { getReconciliationService } from "./getReconciliationService";
import { LedgerAdminService } from "./ledgerAdminService";
import type { AdminAchMandateReader, AdminDebitCardMethodReader, AdminPaymentAttemptReader } from "./ledgerAdminService";

/**
 * PRSprint 23 (docs/prsprints/PRSPRINT_23_ACH_BANK_LINKING_RECONCILIATION.md): thin adapters over the
 * already-existing PaymentService/AchMandateService/DebitCardMethodService, narrowing each down to
 * exactly the read-only shape LedgerAdminService needs (item 109's "provider payment ID; bank account
 * ID; card ID" support-visibility requirement) — never a second write path, never a raw provider
 * token exposed (see ledgerAdminService.ts's own doc comment for what's deliberately omitted).
 */
class PaymentAttemptAdminReaderAdapter implements AdminPaymentAttemptReader {
  async listByAgreementId(agreementId: string) {
    const records = await getPaymentService().listByAgreementId(agreementId);
    return records.map((r) => ({
      id: r.id,
      status: r.status,
      paymentMethod: r.paymentMethod,
      providerName: r.providerName,
      providerPaymentId: r.providerPaymentId,
      amountMinorUnits: r.amountMinorUnits,
      currency: r.currency,
      bankConnectionId: r.bankConnectionId,
      createdAt: r.createdAt,
    }));
  }
}

class AchMandateAdminReaderAdapter implements AdminAchMandateReader {
  async findActiveForAgreement(agreementId: string) {
    const mandate = await getAchMandateService().getActiveMandate(agreementId);
    if (!mandate) return null;
    return { id: mandate.id, status: mandate.status, authorizedAt: mandate.authorizedAt, revokedAt: mandate.revokedAt };
  }
}

class DebitCardMethodAdminReaderAdapter implements AdminDebitCardMethodReader {
  async findActiveForAgreement(agreementId: string) {
    const card = await getDebitCardMethodService().getActiveCard(agreementId);
    if (!card) return null;
    return {
      id: card.id,
      status: card.status,
      cardLast4: card.cardLast4,
      cardBrand: card.cardBrand,
      expiresAtMonth: card.expiresAtMonth,
      expiresAtYear: card.expiresAtYear,
    };
  }
}

let cached: LedgerAdminService | null = null;

export function getLedgerAdminService(): LedgerAdminService {
  if (!cached) {
    cached = new LedgerAdminService({
      ledger: getLedgerService(),
      balance: getBalanceService(),
      reconciliation: getReconciliationService(),
      payments: new PaymentAttemptAdminReaderAdapter(),
      achMandates: new AchMandateAdminReaderAdapter(),
      debitCards: new DebitCardMethodAdminReaderAdapter(),
    });
  }
  return cached;
}
