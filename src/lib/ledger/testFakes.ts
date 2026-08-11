import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { BalanceService } from "./balanceService";
import type { AgreementTermsReader } from "./balanceService";
import { LedgerService } from "./ledgerService";
import type {
  LedgerAccountRecord,
  LedgerAccountRepository,
  LedgerAccountType,
  LedgerEntryType,
  LedgerJournalEntryRecord,
  LedgerJournalEntryRepository,
  LedgerPostingInput,
} from "./ledgerService";
import type { ReconciliationExceptionRecord, ReconciliationExceptionRepository, ReconciliationExceptionType } from "./reconciliationService";

/** Test-only in-memory doubles for LedgerService, mirroring src/lib/payments/testFakes.ts's pattern. */

export class InMemoryLedgerAccountRepository implements LedgerAccountRepository {
  private byKey = new Map<string, LedgerAccountRecord>();

  async findOrCreate(accountType: LedgerAccountType, agreementId: string): Promise<LedgerAccountRecord> {
    const key = `${accountType}:${agreementId}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const record: LedgerAccountRecord = { id: randomUUID(), accountType, agreementId, createdAt: new Date() };
    this.byKey.set(key, record);
    return record;
  }
}

export class InMemoryLedgerJournalEntryRepository implements LedgerJournalEntryRepository {
  private byId = new Map<string, LedgerJournalEntryRecord>();

  async findByPaymentAndType(paymentAttemptId: string, entryType: LedgerEntryType): Promise<LedgerJournalEntryRecord | null> {
    return [...this.byId.values()].find((e) => e.paymentAttemptId === paymentAttemptId && e.entryType === entryType) ?? null;
  }

  async insert(input: {
    entryType: LedgerEntryType;
    agreementId: string;
    paymentAttemptId: string;
    currency: string;
    reason: string | null;
    postings: LedgerPostingInput[];
  }): Promise<LedgerJournalEntryRecord> {
    const existing = await this.findByPaymentAndType(input.paymentAttemptId, input.entryType);
    if (existing) throw new Error("duplicate ledger journal entry (payment_attempt_id, entry_type)");
    const entry: LedgerJournalEntryRecord = {
      id: randomUUID(),
      entryType: input.entryType,
      agreementId: input.agreementId,
      paymentAttemptId: input.paymentAttemptId,
      currency: input.currency,
      reason: input.reason,
      createdAt: new Date(),
      postings: input.postings.map((p) => ({
        id: randomUUID(),
        accountId: p.accountId,
        accountType: p.accountType,
        direction: p.direction,
        amountMinorUnits: p.amountMinorUnits,
      })),
    };
    this.byId.set(entry.id, entry);
    return entry;
  }

  async listForAgreement(agreementId: string): Promise<LedgerJournalEntryRecord[]> {
    return [...this.byId.values()].filter((e) => e.agreementId === agreementId);
  }

  async listForPaymentAttempt(paymentAttemptId: string): Promise<LedgerJournalEntryRecord[]> {
    return [...this.byId.values()].filter((e) => e.paymentAttemptId === paymentAttemptId);
  }
}

class InMemoryAuditEventRepositoryForLedger implements AuditEventRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;

  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events.at(-1) ?? null;
  }

  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const stored: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
}

export function createTestLedgerService() {
  const accounts = new InMemoryLedgerAccountRepository();
  const entries = new InMemoryLedgerJournalEntryRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForLedger();
  const ledgerService = new LedgerService({ accounts, entries, audit: new AuditService(auditRepo) });
  return { accounts, entries, auditRepo, ledgerService };
}

export class InMemoryAgreementTermsReader implements AgreementTermsReader {
  private byAgreementId = new Map<string, { principalMinorUnits: number; currency: string }>();

  set(agreementId: string, principalMinorUnits: number, currency = "USD"): void {
    this.byAgreementId.set(agreementId, { principalMinorUnits, currency });
  }

  async getPrincipal(agreementId: string): Promise<{ principalMinorUnits: number; currency: string } | null> {
    return this.byAgreementId.get(agreementId) ?? null;
  }
}

/** Builds a BalanceService test context sharing an existing LedgerService test context's ledger. */
export function createTestBalanceService(ledgerCtx: ReturnType<typeof createTestLedgerService>) {
  const terms = new InMemoryAgreementTermsReader();
  const balanceService = new BalanceService({ ledger: ledgerCtx.ledgerService, terms });
  return { terms, balanceService };
}

export class InMemoryReconciliationExceptionRepository implements ReconciliationExceptionRepository {
  private byId = new Map<string, ReconciliationExceptionRecord>();

  async findOpen(
    exceptionType: ReconciliationExceptionType,
    paymentAttemptId: string | null,
    providerEventId: string | null,
  ): Promise<ReconciliationExceptionRecord | null> {
    return (
      [...this.byId.values()].find(
        (e) =>
          e.exceptionType === exceptionType &&
          e.status === "open" &&
          e.paymentAttemptId === paymentAttemptId &&
          e.providerEventId === providerEventId,
      ) ?? null
    );
  }

  async insert(input: {
    exceptionType: ReconciliationExceptionType;
    paymentAttemptId: string | null;
    providerEventId: string | null;
    details: unknown;
  }): Promise<ReconciliationExceptionRecord> {
    const record: ReconciliationExceptionRecord = {
      id: randomUUID(),
      status: "open",
      detectedAt: new Date(),
      resolvedAt: null,
      resolvedByUserId: null,
      resolutionReason: null,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async listOpen(): Promise<ReconciliationExceptionRecord[]> {
    return [...this.byId.values()].filter((e) => e.status === "open");
  }

  async listForPaymentAttempt(paymentAttemptId: string): Promise<ReconciliationExceptionRecord[]> {
    return [...this.byId.values()].filter((e) => e.paymentAttemptId === paymentAttemptId);
  }

  async resolve(id: string, resolvedByUserId: string, resolutionReason: string): Promise<ReconciliationExceptionRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("reconciliation_exception not found");
    record.status = "resolved";
    record.resolvedAt = new Date();
    record.resolvedByUserId = resolvedByUserId;
    record.resolutionReason = resolutionReason;
    return record;
  }
}
