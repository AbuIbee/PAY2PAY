import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ConfigurationError, ConflictError, ValidationError } from "@/lib/errors";

export type LedgerAccountType =
  | "processor_clearing"
  | "creditor_proceeds_payable"
  | "platform_fee_revenue"
  | "processor_fee_expense"
  | "creditor_clawback_exposure"
  | "admin_adjustment_suspense";

export type LedgerEntryType = "payment_cleared" | "refund" | "reversal" | "payout" | "dispute_adjustment" | "admin_adjustment";
export type LedgerPostingDirection = "debit" | "credit";
/** Automatic entry types, each posted at most once per payment attempt via idempotent get-or-post. */
export type AutomaticReversalEntryType = "refund" | "reversal" | "dispute_adjustment";

export interface LedgerAccountRecord {
  id: string;
  accountType: LedgerAccountType;
  agreementId: string;
  createdAt: Date;
}

export interface LedgerPostingRecord {
  id: string;
  accountId: string;
  /** Denormalized from the account row at posting time — avoids a join for every balance read. */
  accountType: LedgerAccountType;
  direction: LedgerPostingDirection;
  amountMinorUnits: number;
}

export interface LedgerJournalEntryRecord {
  id: string;
  entryType: LedgerEntryType;
  agreementId: string;
  paymentAttemptId: string;
  currency: string;
  reason: string | null;
  createdAt: Date;
  postings: LedgerPostingRecord[];
}

/**
 * Sprint 10 (docs/sprints/SPRINT_10_InternalFinancialLedger.md) account registry. Deliberately no
 * "list all accounts" or "adjust balance" method — an account's balance is always derived by
 * summing its postings (this sprint's requirement #6), never stored or mutated directly.
 */
export interface LedgerAccountRepository {
  findOrCreate(accountType: LedgerAccountType, agreementId: string): Promise<LedgerAccountRecord>;
}

export interface LedgerPostingInput {
  accountId: string;
  accountType: LedgerAccountType;
  direction: LedgerPostingDirection;
  amountMinorUnits: number;
}

/**
 * The append-only journal. `insert` must persist the entry and all of its postings atomically (one
 * DB transaction in the Drizzle implementation) — a journal entry with only some of its postings
 * would violate "balanced entries" the instant it became visible to a reader.
 */
export interface LedgerJournalEntryRepository {
  findByPaymentAndType(paymentAttemptId: string, entryType: LedgerEntryType): Promise<LedgerJournalEntryRecord | null>;
  insert(input: {
    entryType: LedgerEntryType;
    agreementId: string;
    paymentAttemptId: string;
    currency: string;
    reason: string | null;
    postings: LedgerPostingInput[];
  }): Promise<LedgerJournalEntryRecord>;
  listForAgreement(agreementId: string): Promise<LedgerJournalEntryRecord[]>;
  listForPaymentAttempt(paymentAttemptId: string): Promise<LedgerJournalEntryRecord[]>;
}

/**
 * Sprint 10's posting engine — the only code in this codebase that writes to `ledger_journal_entry`/
 * `ledger_posting`. Every public method here is idempotent (get-existing-or-post-once, keyed by
 * `(paymentAttemptId, entryType)`), so a webhook retry or a reconciliation re-run calling the same
 * method twice never double-posts (requirements #5, #12). Every posting set is validated balanced
 * (`assertBalanced`) before it is ever written. Nothing here ever touches `agreement`,
 * `agreement_version`, `signature_event`, or any prior sprint's immutable records (requirement #7) —
 * this class has no dependency capable of writing to any of them.
 */
export class LedgerService {
  constructor(
    private readonly deps: {
      accounts: LedgerAccountRepository;
      entries: LedgerJournalEntryRepository;
      audit: AuditService;
    },
  ) {}

  /**
   * docs/PAYMENT_ARCHITECTURE.md §14 posting 1. `processorFeeMinorUnits`/`platformFeeMinorUnits`
   * default to 0 — Sprint 9's sandbox provider does not return real fee data (documented Sprint 10
   * limitation); callers that have real fee amounts (a webhook payload, in this sprint's wiring)
   * pass them explicitly.
   */
  async postPaymentCleared(input: {
    paymentAttemptId: string;
    agreementId: string;
    currency: string;
    grossAmountMinorUnits: number;
    processorFeeMinorUnits?: number;
    platformFeeMinorUnits?: number;
  }): Promise<LedgerJournalEntryRecord> {
    const existing = await this.deps.entries.findByPaymentAndType(input.paymentAttemptId, "payment_cleared");
    if (existing) return existing;

    const processorFee = input.processorFeeMinorUnits ?? 0;
    const platformFee = input.platformFeeMinorUnits ?? 0;
    this.assertNonNegativeInteger(input.grossAmountMinorUnits, "grossAmountMinorUnits");
    this.assertNonNegativeInteger(processorFee, "processorFeeMinorUnits");
    this.assertNonNegativeInteger(platformFee, "platformFeeMinorUnits");
    if (input.grossAmountMinorUnits === 0) {
      throw new ValidationError("grossAmountMinorUnits must be greater than zero.");
    }
    const creditorNet = input.grossAmountMinorUnits - processorFee - platformFee;
    if (creditorNet < 0) {
      throw new ValidationError("Processor fee and platform fee cannot together exceed the gross payment amount.");
    }

    const processorClearing = await this.deps.accounts.findOrCreate("processor_clearing", input.agreementId);
    const postings: LedgerPostingInput[] = [
      { accountId: processorClearing.id, accountType: "processor_clearing", direction: "debit", amountMinorUnits: input.grossAmountMinorUnits },
    ];
    if (creditorNet > 0) {
      const creditorPayable = await this.deps.accounts.findOrCreate("creditor_proceeds_payable", input.agreementId);
      postings.push({ accountId: creditorPayable.id, accountType: "creditor_proceeds_payable", direction: "credit", amountMinorUnits: creditorNet });
    }
    if (platformFee > 0) {
      const platformFeeRevenue = await this.deps.accounts.findOrCreate("platform_fee_revenue", input.agreementId);
      postings.push({ accountId: platformFeeRevenue.id, accountType: "platform_fee_revenue", direction: "credit", amountMinorUnits: platformFee });
    }
    if (processorFee > 0) {
      const processorFeeExpense = await this.deps.accounts.findOrCreate("processor_fee_expense", input.agreementId);
      postings.push({ accountId: processorFeeExpense.id, accountType: "processor_fee_expense", direction: "credit", amountMinorUnits: processorFee });
    }
    this.assertBalanced(postings);

    const entry = await this.deps.entries.insert({
      entryType: "payment_cleared",
      agreementId: input.agreementId,
      paymentAttemptId: input.paymentAttemptId,
      currency: input.currency,
      reason: null,
      postings,
    });
    await this.recordAudit(entry, "ledger_payment_cleared", null, "ledger_system");
    return entry;
  }

  /**
   * `refund` (voluntary/dispute-resolved), `reversal` (bank/network-initiated return), and
   * `dispute_adjustment` (a dispute opened, before resolution) all share one accounting shape,
   * auto-selected by whether a `payout` entry already exists for this payment — mirrors
   * docs/PAYMENT_ARCHITECTURE.md §14 postings 3 (pre-payout) and 4 (post-payout), and §10's "all
   * three [return, chargeback, refund] converge on the same ledger operation."
   */
  async reversePayment(input: {
    paymentAttemptId: string;
    entryType: AutomaticReversalEntryType;
    reason: string | null;
  }): Promise<LedgerJournalEntryRecord> {
    const existing = await this.deps.entries.findByPaymentAndType(input.paymentAttemptId, input.entryType);
    if (existing) return existing;

    const clearEntry = await this.deps.entries.findByPaymentAndType(input.paymentAttemptId, "payment_cleared");
    if (!clearEntry) {
      throw new ValidationError("Cannot reverse a payment that has not cleared.");
    }
    const payoutEntry = await this.deps.entries.findByPaymentAndType(input.paymentAttemptId, "payout");

    let postings: LedgerPostingInput[];
    if (payoutEntry) {
      const creditorLeg = clearEntry.postings.find((p) => p.accountType === "creditor_proceeds_payable");
      if (!creditorLeg) {
        throw new ConfigurationError("payment_cleared entry is missing its creditor_proceeds_payable leg.");
      }
      const [clawback, processorClearing] = await Promise.all([
        this.deps.accounts.findOrCreate("creditor_clawback_exposure", clearEntry.agreementId),
        this.deps.accounts.findOrCreate("processor_clearing", clearEntry.agreementId),
      ]);
      postings = [
        { accountId: clawback.id, accountType: "creditor_clawback_exposure", direction: "debit", amountMinorUnits: creditorLeg.amountMinorUnits },
        { accountId: processorClearing.id, accountType: "processor_clearing", direction: "credit", amountMinorUnits: creditorLeg.amountMinorUnits },
      ];
    } else {
      postings = clearEntry.postings.map((p) => ({
        accountId: p.accountId,
        accountType: p.accountType,
        direction: p.direction === "debit" ? "credit" : "debit",
        amountMinorUnits: p.amountMinorUnits,
      }));
    }
    this.assertBalanced(postings);

    const entry = await this.deps.entries.insert({
      entryType: input.entryType,
      agreementId: clearEntry.agreementId,
      paymentAttemptId: input.paymentAttemptId,
      currency: clearEntry.currency,
      reason: input.reason,
      postings,
    });
    await this.recordAudit(entry, `ledger_${input.entryType}`, null, "ledger_system");
    return entry;
  }

  /** docs/PAYMENT_ARCHITECTURE.md §14 posting 2, single-step (no `payout_in_transit` intermediate — see enums.ts's doc comment). Blocked once a payment has been refunded/reversed/disputed. */
  async postPayout(input: { paymentAttemptId: string; reason?: string | null }): Promise<LedgerJournalEntryRecord> {
    const existing = await this.deps.entries.findByPaymentAndType(input.paymentAttemptId, "payout");
    if (existing) return existing;

    const clearEntry = await this.deps.entries.findByPaymentAndType(input.paymentAttemptId, "payment_cleared");
    if (!clearEntry) {
      throw new ValidationError("Cannot pay out a payment that has not cleared.");
    }
    const reversalChecks = await Promise.all(
      (["refund", "reversal", "dispute_adjustment"] as const).map((entryType) =>
        this.deps.entries.findByPaymentAndType(input.paymentAttemptId, entryType),
      ),
    );
    if (reversalChecks.some((entry) => entry !== null)) {
      throw new ValidationError("Cannot pay out a payment that has been refunded, reversed, or disputed.");
    }

    const creditorLeg = clearEntry.postings.find((p) => p.accountType === "creditor_proceeds_payable");
    if (!creditorLeg) {
      throw new ValidationError("There are no creditor proceeds to pay out for this payment.");
    }

    const processorClearing = await this.deps.accounts.findOrCreate("processor_clearing", clearEntry.agreementId);
    const postings: LedgerPostingInput[] = [
      { accountId: creditorLeg.accountId, accountType: "creditor_proceeds_payable", direction: "debit", amountMinorUnits: creditorLeg.amountMinorUnits },
      { accountId: processorClearing.id, accountType: "processor_clearing", direction: "credit", amountMinorUnits: creditorLeg.amountMinorUnits },
    ];
    this.assertBalanced(postings);

    const entry = await this.deps.entries.insert({
      entryType: "payout",
      agreementId: clearEntry.agreementId,
      paymentAttemptId: input.paymentAttemptId,
      currency: clearEntry.currency,
      reason: input.reason ?? null,
      postings,
    });
    await this.recordAudit(entry, "ledger_payout", null, "ledger_system");
    return entry;
  }

  /**
   * Requirement #18: the only human-triggerable posting, always balanced against a dedicated
   * suspense account (never fabricates a real counterparty movement) and always requires a
   * non-empty reason. Never edits or deletes a prior entry — this is always a new, additional row.
   * A payment may have at most one administrative adjustment in this sprint (see this file's test
   * suite / docs/SPRINT_CONTROL.md's Sprint 10 notes for why multiple sequential corrections per
   * payment are out of scope) — a second attempt is a caller error, not a silent no-op, so it
   * throws `ConflictError` rather than idempotently returning the first one.
   */
  async postAdminAdjustment(input: {
    paymentAttemptId: string;
    agreementId: string;
    currency: string;
    targetAccountType: Exclude<LedgerAccountType, "admin_adjustment_suspense">;
    direction: LedgerPostingDirection;
    amountMinorUnits: number;
    reason: string;
    actingUserId: string;
  }): Promise<LedgerJournalEntryRecord> {
    if (!input.reason.trim()) {
      throw new ValidationError("A reason is required for an administrative adjustment.");
    }
    this.assertNonNegativeInteger(input.amountMinorUnits, "amountMinorUnits");
    if (input.amountMinorUnits === 0) {
      throw new ValidationError("amountMinorUnits must be greater than zero.");
    }

    const existing = await this.deps.entries.findByPaymentAndType(input.paymentAttemptId, "admin_adjustment");
    if (existing) {
      throw new ConflictError("An administrative adjustment has already been posted for this payment.");
    }

    const [targetAccount, suspense] = await Promise.all([
      this.deps.accounts.findOrCreate(input.targetAccountType, input.agreementId),
      this.deps.accounts.findOrCreate("admin_adjustment_suspense", input.agreementId),
    ]);
    const oppositeDirection: LedgerPostingDirection = input.direction === "debit" ? "credit" : "debit";
    const postings: LedgerPostingInput[] = [
      { accountId: targetAccount.id, accountType: input.targetAccountType, direction: input.direction, amountMinorUnits: input.amountMinorUnits },
      { accountId: suspense.id, accountType: "admin_adjustment_suspense", direction: oppositeDirection, amountMinorUnits: input.amountMinorUnits },
    ];
    this.assertBalanced(postings);

    const entry = await this.deps.entries.insert({
      entryType: "admin_adjustment",
      agreementId: input.agreementId,
      paymentAttemptId: input.paymentAttemptId,
      currency: input.currency,
      reason: input.reason,
      postings,
    });
    await this.recordAudit(entry, "ledger_admin_adjustment", input.actingUserId, "platform_owner");
    return entry;
  }

  async findEntry(paymentAttemptId: string, entryType: LedgerEntryType): Promise<LedgerJournalEntryRecord | null> {
    return this.deps.entries.findByPaymentAndType(paymentAttemptId, entryType);
  }

  async listEntriesForAgreement(agreementId: string): Promise<LedgerJournalEntryRecord[]> {
    return this.deps.entries.listForAgreement(agreementId);
  }

  async listEntriesForPaymentAttempt(paymentAttemptId: string): Promise<LedgerJournalEntryRecord[]> {
    return this.deps.entries.listForPaymentAttempt(paymentAttemptId);
  }

  /** Exported for ReconciliationService/tests — "balance invariant" is checked the same way everywhere. */
  assertBalanced(postings: LedgerPostingInput[]): void {
    let debitTotal = 0;
    let creditTotal = 0;
    for (const posting of postings) {
      this.assertNonNegativeInteger(posting.amountMinorUnits, "amountMinorUnits");
      if (posting.direction === "debit") debitTotal += posting.amountMinorUnits;
      else creditTotal += posting.amountMinorUnits;
    }
    if (debitTotal !== creditTotal) {
      throw new ConfigurationError(`Ledger postings are not balanced: debits ${debitTotal} != credits ${creditTotal}.`);
    }
  }

  private assertNonNegativeInteger(value: number, label: string): void {
    // PRSprint 17: Number.isSafeInteger — see schedule.ts's identical hardening rationale.
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${label} must be a non-negative integer.`);
    }
  }

  private async recordAudit(
    entry: LedgerJournalEntryRecord,
    action: string,
    actorUserId: string | null,
    actorRole: string,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole,
      profileKind: null,
      profileId: null,
      agreementId: entry.agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: entry.postings.map((p) => ({ accountType: p.accountType, direction: p.direction, amountMinorUnits: p.amountMinorUnits })),
      reason: entry.reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "ledger_journal_entry",
      targetResourceId: entry.id,
    });
  }
}
