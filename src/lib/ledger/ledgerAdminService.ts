import "server-only";
import type { PlatformRole } from "@/lib/auth/authService";
import { isAdminRole, isOwnerRole } from "@/lib/admin/capabilities";
import { ForbiddenError } from "@/lib/errors";
import type { AgreementBalance, BalanceService } from "./balanceService";
import type { LedgerAccountType, LedgerJournalEntryRecord, LedgerPostingDirection, LedgerService } from "./ledgerService";
import type { ReconciliationExceptionRecord, ReconciliationService } from "./reconciliationService";

/**
 * PRSprint 23 (docs/prsprints/PRSPRINT_23_ACH_BANK_LINKING_RECONCILIATION.md) item 109 ("Support
 * should see provider references: provider payment ID; webhook event ID; bank account ID; card ID")
 * addition. Deliberately never exposes a raw provider token (`bank_account_ref`/`card_token`) — only
 * `providerPaymentId` (already a provider-issued *transaction* reference, not a reusable credential,
 * matching payment_attempt's own existing "external reference only" precedent) and, for cards, the
 * same non-sensitive last4/brand/expiry display metadata `debit_card_method` already stores. This
 * mirrors `AdminFinancialAccountAssignmentView`'s established "omit the reusable provider token
 * entirely" precedent (relationshipFinancialAccountService.ts) applied to the ACH/card-on-file layer.
 */
export interface AdminPaymentAttemptSummary {
  id: string;
  status: string;
  paymentMethod: string | null;
  providerName: string;
  providerPaymentId: string | null;
  amountMinorUnits: number;
  currency: string;
  createdAt: Date;
}

export interface AdminAchMandateSummary {
  id: string;
  status: string;
  authorizedAt: Date;
  revokedAt: Date | null;
}

export interface AdminDebitCardMethodSummary {
  id: string;
  status: string;
  cardLast4: string;
  cardBrand: string | null;
  expiresAtMonth: number;
  expiresAtYear: number;
}

export interface AgreementLedgerView {
  balance: AgreementBalance;
  entries: LedgerJournalEntryRecord[];
  exceptions: ReconciliationExceptionRecord[];
  /** PRSprint 23: every payment attempt against this agreement, with its provider reference — support-troubleshooting visibility, not a second balance source (BalanceService/entries above remain authoritative). */
  paymentAttempts: AdminPaymentAttemptSummary[];
  /** PRSprint 23: the currently-active ACH mandate, if any — never the raw bank_account_ref token. */
  activeAchMandate: AdminAchMandateSummary | null;
  /** PRSprint 23: the currently-active debit-card-on-file, if any — never the raw card_token. */
  activeDebitCard: AdminDebitCardMethodSummary | null;
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
/** PRSprint 23: narrow readers, mirroring this class's own established "reuse existing repos/services read-only" pattern — never a second write path to any of these tables. */
export interface AdminPaymentAttemptReader {
  listByAgreementId(agreementId: string): Promise<AdminPaymentAttemptSummary[]>;
}
export interface AdminAchMandateReader {
  findActiveForAgreement(agreementId: string): Promise<AdminAchMandateSummary | null>;
}
export interface AdminDebitCardMethodReader {
  findActiveForAgreement(agreementId: string): Promise<AdminDebitCardMethodSummary | null>;
}

export class LedgerAdminService {
  constructor(
    private readonly deps: {
      ledger: LedgerService;
      balance: BalanceService;
      reconciliation: ReconciliationService;
      /** PRSprint 23: optional — every pre-PRSprint-23 test/call site omitting them is unaffected (paymentAttempts/activeAchMandate/activeDebitCard simply come back empty/null). */
      payments?: AdminPaymentAttemptReader;
      achMandates?: AdminAchMandateReader;
      debitCards?: AdminDebitCardMethodReader;
    },
  ) {}

  async getAgreementLedgerView(actingRole: PlatformRole, agreementId: string): Promise<AgreementLedgerView> {
    this.requireAdmin(actingRole);
    const [balance, entries] = await Promise.all([
      this.deps.balance.getAgreementBalance(agreementId),
      this.deps.ledger.listEntriesForAgreement(agreementId),
    ]);
    const paymentAttemptIds = [...new Set(entries.map((e) => e.paymentAttemptId))];
    const [exceptionLists, paymentAttempts, activeAchMandate, activeDebitCard] = await Promise.all([
      Promise.all(paymentAttemptIds.map((id) => this.deps.reconciliation.listExceptionsForPaymentAttempt(id))),
      this.deps.payments?.listByAgreementId(agreementId) ?? Promise.resolve([]),
      this.deps.achMandates?.findActiveForAgreement(agreementId) ?? Promise.resolve(null),
      this.deps.debitCards?.findActiveForAgreement(agreementId) ?? Promise.resolve(null),
    ]);
    return { balance, entries, exceptions: exceptionLists.flat(), paymentAttempts, activeAchMandate, activeDebitCard };
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
