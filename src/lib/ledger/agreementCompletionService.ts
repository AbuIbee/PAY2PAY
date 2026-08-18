import "server-only";
import type { AuditService } from "@/lib/audit/auditService";

/**
 * PRSprint 18 (docs/prsprints/PRSPRINT_18_PARTIAL_PAYMENTS_OVERPAYMENTS_COMPLETION_RULES.md): narrow
 * view onto `BalanceService` — this module only ever needs settlement state and the paid total.
 * Mirrors this codebase's interface-segregation precedent (e.g. `AgreementTermsReader`).
 */
export interface AgreementBalanceComputer {
  getAgreementBalance(
    agreementId: string,
  ): Promise<{ settlementState: "unpaid" | "partially_paid" | "paid_in_full" | "overpaid"; amountPaidMinorUnits: number }>;
}

/**
 * PRSprint 18: narrow view onto `AgreementRepository` — this module only ever reads current status
 * and writes exactly the two statuses it's responsible for. Structurally compatible with the real
 * `AgreementRepository` (a function accepting the full `AgreementStatus` union may always be called
 * with the narrower "active" | "paid_in_full", and `AgreementRecord` already has a `status` field).
 */
export interface AgreementStatusRepository {
  findById(agreementId: string): Promise<{ status: string } | null>;
  updateStatus(agreementId: string, status: "active" | "paid_in_full"): Promise<void>;
}

/**
 * PRSprint 18: closes the gap identified in docs/prsprints/PHASE_5_PREFLIGHT_FINDINGS.md §6-7 —
 * before this PRSprint, nothing in this codebase ever wrote `agreement.status = "paid_in_full"`; the
 * only existing agreement-completion write path was `SettlementService`'s `"settled_in_full"`, a
 * deliberately separate lifecycle for a negotiated settlement. This class implements the other two
 * `docs/STATE_MACHINES.md` §1 edges real ordinary installment payments require to ever reach
 * completion: "FirstPaymentPending --> Active: first payment cleared" (a prerequisite — without it, an
 * agreement whose principal spans more than one payment could never leave FirstPaymentPending for
 * Active to complete "Active --> PaidInFull" from) and "{Active,PastDue} --> PaidInFull: full balance
 * clears". Does not implement the fuller Active <-> PastDue <-> Disputed <-> PausedByAmendment web —
 * see the PRSprint 18 completion report's "known limitations" section for why that's out of this
 * PRSprint's four acceptance criteria.
 *
 * Idempotent by construction: `checkAndAdvance` only ever acts while the agreement is in one of the
 * three source statuses this class is scoped to (`first_payment_pending`/`active`/`past_due`) — once
 * it writes `paid_in_full`, a second call is a no-op via the same early-return, with no separate
 * "already done" check needed. Never touches a disputed, paused, settled, or otherwise-closed
 * agreement — a completion or activation transition must never fire underneath an open dispute or an
 * amendment-applied pause, and settlement's own `"settled_in_full"` lifecycle is untouched.
 */
export class AgreementCompletionService {
  constructor(
    private readonly deps: {
      agreements: AgreementStatusRepository;
      balances: AgreementBalanceComputer;
      audit: AuditService;
    },
  ) {}

  async checkAndAdvance(agreementId: string): Promise<void> {
    const agreement = await this.deps.agreements.findById(agreementId);
    if (!agreement) return;
    const currentStatus = agreement.status;
    if (currentStatus !== "first_payment_pending" && currentStatus !== "active" && currentStatus !== "past_due") {
      return;
    }

    let balance: { settlementState: "unpaid" | "partially_paid" | "paid_in_full" | "overpaid"; amountPaidMinorUnits: number };
    try {
      balance = await this.deps.balances.getAgreementBalance(agreementId);
    } catch {
      return; // no signed terms yet — nothing to evaluate.
    }

    // "overpaid" should never actually occur — PaymentService.assertNotOverpaying blocks it upstream
    // — but a full balance clears the debt either way, so this branch is defense-in-depth, not the
    // primary enforcement point (see PHASE_5_PREFLIGHT_FINDINGS.md §7 item 2 for the actual policy).
    if (balance.settlementState === "paid_in_full" || balance.settlementState === "overpaid") {
      await this.deps.agreements.updateStatus(agreementId, "paid_in_full");
      await this.recordAudit(agreementId, "agreement_paid_in_full", balance.amountPaidMinorUnits);
      return;
    }

    if (currentStatus === "first_payment_pending" && balance.amountPaidMinorUnits > 0) {
      await this.deps.agreements.updateStatus(agreementId, "active");
      await this.recordAudit(agreementId, "agreement_activated", balance.amountPaidMinorUnits);
    }
  }

  private async recordAudit(agreementId: string, action: string, amountPaidMinorUnits: number): Promise<void> {
    await this.deps.audit.record({
      actorUserId: null,
      actorRole: "ledger_system",
      profileKind: null,
      profileId: null,
      agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: { amountPaidMinorUnits },
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "agreement",
      targetResourceId: agreementId,
    });
  }
}
