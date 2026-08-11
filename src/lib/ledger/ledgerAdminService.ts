import "server-only";
import type { PlatformRole } from "@/lib/auth/authService";
import { isAdminRole, isOwnerRole } from "@/lib/admin/capabilities";
import { ForbiddenError } from "@/lib/errors";
import type { AgreementBalance, BalanceService } from "./balanceService";
import type { LedgerAccountType, LedgerJournalEntryRecord, LedgerPostingDirection, LedgerService } from "./ledgerService";
import type { ReconciliationExceptionRecord, ReconciliationService } from "./reconciliationService";

export interface AgreementLedgerView {
  balance: AgreementBalance;
  entries: LedgerJournalEntryRecord[];
  exceptions: ReconciliationExceptionRecord[];
}

/**
 * Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md) requirements #17/#18/#21: read-only
 * ledger/reconciliation visibility for Platform Admin and Platform Owner, plus the one
 * human-triggerable posting (`postAdjustment`), gated more strictly (Owner only — money movement is
 * higher-risk than the read-only visibility this class otherwise provides, and than Sprint 6A's own
 * admin-role-change gating, which this mirrors). Deliberately a new, separate service — never
 * touches src/lib/admin/adminService.ts — reusing only its shared, already-audited role-check
 * helpers (`isAdminRole`/`isOwnerRole`) so the platform-role hierarchy is checked exactly the same
 * way everywhere in the codebase. There is no "edit ledger" or "delete entry" method anywhere in
 * this class — every write is a new, additional, reasoned, audited row.
 */
export class LedgerAdminService {
  constructor(
    private readonly deps: {
      ledger: LedgerService;
      balance: BalanceService;
      reconciliation: ReconciliationService;
    },
  ) {}

  async getAgreementLedgerView(actingRole: PlatformRole, agreementId: string): Promise<AgreementLedgerView> {
    this.requireAdmin(actingRole);
    const [balance, entries] = await Promise.all([
      this.deps.balance.getAgreementBalance(agreementId),
      this.deps.ledger.listEntriesForAgreement(agreementId),
    ]);
    const paymentAttemptIds = [...new Set(entries.map((e) => e.paymentAttemptId))];
    const exceptionLists = await Promise.all(
      paymentAttemptIds.map((id) => this.deps.reconciliation.listExceptionsForPaymentAttempt(id)),
    );
    return { balance, entries, exceptions: exceptionLists.flat() };
  }

  async listOpenExceptions(actingRole: PlatformRole): Promise<ReconciliationExceptionRecord[]> {
    this.requireAdmin(actingRole);
    return this.deps.reconciliation.listOpenExceptions();
  }

  async runReconciliation(actingRole: PlatformRole): Promise<ReconciliationExceptionRecord[]> {
    this.requireAdmin(actingRole);
    return this.deps.reconciliation.reconcileAll();
  }

  async resolveException(
    actingRole: PlatformRole,
    actingUserId: string,
    exceptionId: string,
    resolutionReason: string,
  ): Promise<ReconciliationExceptionRecord> {
    this.requireAdmin(actingRole);
    return this.deps.reconciliation.resolveException(exceptionId, actingUserId, resolutionReason);
  }

  async postAdjustment(
    actingRole: PlatformRole,
    actingUserId: string,
    input: {
      paymentAttemptId: string;
      agreementId: string;
      currency: string;
      targetAccountType: Exclude<LedgerAccountType, "admin_adjustment_suspense">;
      direction: LedgerPostingDirection;
      amountMinorUnits: number;
      reason: string;
    },
  ): Promise<LedgerJournalEntryRecord> {
    this.requireOwner(actingRole);
    return this.deps.ledger.postAdminAdjustment({ ...input, actingUserId });
  }

  private requireAdmin(role: PlatformRole): void {
    if (!isAdminRole(role)) {
      throw new ForbiddenError("Administrative access is required.");
    }
  }

  private requireOwner(role: PlatformRole): void {
    if (!isOwnerRole(role)) {
      throw new ForbiddenError("Platform Owner access is required to post a ledger adjustment.");
    }
  }
}
