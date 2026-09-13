import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import type { PartyRole } from "@/lib/agreements/agreementService";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { createTestPaymentService } from "@/lib/payments/testFakes";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { SettlementService } from "./settlementService";
import type {
  NormalizedSettlementTerms,
  RecordWithinSettlementCeilingResult,
  SettlementFailureConsequence,
  SettlementPaymentRepository,
  SettlementProposalRecord,
  SettlementProposalRepository,
} from "./settlementService";

/** Test-only in-memory double for SettlementProposalRepository, mirroring src/lib/amendments/testFakes.ts's pattern. */
export class InMemorySettlementProposalRepository implements SettlementProposalRepository {
  byId = new Map<string, SettlementProposalRecord>();

  async insert(
    input: { agreementId: string; proposingPartyRole: PartyRole; proposedByProfileKind: ProfileKind; proposedByProfileId: string } & NormalizedSettlementTerms,
  ): Promise<SettlementProposalRecord> {
    const now = new Date();
    const record: SettlementProposalRecord = {
      id: randomUUID(),
      status: "proposed",
      rejectedReason: null,
      rejectedAt: null,
      acceptedAt: null,
      completedAt: null,
      resolvedConsequence: null,
      resolvedRestoredBalanceMinorUnits: null,
      resolvedForgivenAmountMinorUnits: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      ...input,
      failureConsequenceStatedAmountMinorUnits: input.failureConsequenceStatedAmountMinorUnits ?? null,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<SettlementProposalRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForAgreement(agreementId: string): Promise<SettlementProposalRecord[]> {
    return [...this.byId.values()]
      .filter((p) => p.agreementId === agreementId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private mustFind(id: string): SettlementProposalRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("settlement_proposal not found");
    return record;
  }

  async updateProposedContent(
    id: string,
    input: { proposingPartyRole: PartyRole; proposedByProfileKind: ProfileKind; proposedByProfileId: string } & NormalizedSettlementTerms,
  ): Promise<SettlementProposalRecord> {
    const record = this.mustFind(id);
    Object.assign(record, input, { failureConsequenceStatedAmountMinorUnits: input.failureConsequenceStatedAmountMinorUnits ?? null });
    record.updatedAt = new Date();
    return record;
  }

  async recordAccepted(id: string): Promise<SettlementProposalRecord> {
    const record = this.mustFind(id);
    record.status = "awaiting_payment";
    record.acceptedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordRejection(id: string, reason: string | null): Promise<SettlementProposalRecord> {
    const record = this.mustFind(id);
    record.status = "rejected";
    record.rejectedReason = reason;
    record.rejectedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordCompleted(id: string): Promise<SettlementProposalRecord> {
    const record = this.mustFind(id);
    record.status = "completed";
    record.completedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordFailureConsequence(
    id: string,
    input: {
      resolvedConsequence: SettlementFailureConsequence;
      resolvedRestoredBalanceMinorUnits: number | null;
      resolvedForgivenAmountMinorUnits: number | null;
    },
  ): Promise<SettlementProposalRecord> {
    const record = this.mustFind(id);
    record.status = "failure_consequence_applied";
    Object.assign(record, input);
    record.resolvedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async findAwaitingPaymentPastDeadline(now: Date): Promise<SettlementProposalRecord[]> {
    return [...this.byId.values()].filter((p) => p.status === "awaiting_payment" && p.deadline < now.toISOString().slice(0, 10));
  }
}

/**
 * R11 PASS B2 (Check 5): in-memory double for `recordWithinSettlementCeiling` — single-threaded (no
 * real concurrency in a unit test), so this reproduces the real implementation's SEQUENCE of checks
 * exactly (not-awaiting-payment -> already-linked -> sum -> ceiling -> insert) without needing an
 * actual row lock; held to the SAME atomic-result contract as `DrizzleSettlementPaymentRepository`.
 */
export class InMemorySettlementPaymentRepository implements SettlementPaymentRepository {
  rows: { settlementProposalId: string; paymentAttemptId: string; amountMinorUnits: number }[] = [];

  constructor(private readonly proposals: InMemorySettlementProposalRepository) {}

  async recordWithinSettlementCeiling(input: { settlementProposalId: string; paymentAttemptId: string; amountMinorUnits: number }): Promise<RecordWithinSettlementCeilingResult> {
    const proposal = await this.proposals.findById(input.settlementProposalId);
    if (!proposal || proposal.status !== "awaiting_payment") {
      return { outcome: "not_awaiting_payment" };
    }
    if (this.rows.some((r) => r.paymentAttemptId === input.paymentAttemptId)) {
      return { outcome: "already_linked" };
    }
    const existingTotal = await this.sumForSettlement(input.settlementProposalId);
    const newTotal = existingTotal + input.amountMinorUnits;
    if (newTotal > proposal.settlementAmountMinorUnits) {
      return { outcome: "would_exceed_settlement_amount", totalCollectedMinorUnits: existingTotal };
    }
    this.rows.push(input);
    return { outcome: "recorded", totalCollectedMinorUnits: newTotal };
  }

  async sumForSettlement(settlementProposalId: string): Promise<number> {
    return this.rows.filter((r) => r.settlementProposalId === settlementProposalId).reduce((sum, r) => sum + r.amountMinorUnits, 0);
  }
}

class InMemoryAuditEventRepositoryForSettlements implements AuditEventRepository {
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

/**
 * Full Sprint 15 test context, sharing one AgreementService instance set, one PaymentService
 * instance set, and one MfaService instance set with the underlying test fakes — exactly as
 * production does, mirroring src/lib/amendments/testFakes.ts's identical shared-context pattern.
 */
export function createTestSettlementService() {
  const agreementCtx = createTestAgreementService();
  const paymentCtx = createTestPaymentService();
  const mfaCtx = createTestMfaService();
  const proposals = new InMemorySettlementProposalRepository();
  const settlementPayments = new InMemorySettlementPaymentRepository(proposals);
  const auditRepo = new InMemoryAuditEventRepositoryForSettlements();

  const settlementService = new SettlementService({
    agreementService: agreementCtx.agreementService,
    agreements: agreementCtx.agreements,
    proposals,
    settlementPayments,
    payments: paymentCtx.payments,
    mfa: mfaCtx.mfaService,
    audit: new AuditService(auditRepo),
  });

  return { agreementCtx, paymentCtx, mfaCtx, proposals, settlementPayments, auditRepo, settlementService };
}

/** Test-only helper: grants a fresh step-up for (userId, sessionId), mirroring src/lib/staff/testFakes.ts's grantStepUp. */
export async function grantSettlementStepUp(
  mfaCtx: ReturnType<typeof createTestMfaService>,
  userId: string,
  sessionId: string,
): Promise<void> {
  const credential = await mfaCtx.credentials.insert({ userId, method: "totp", secretRef: "test-secret", phoneRef: null });
  await mfaCtx.credentials.markVerified(credential.id);
  await mfaCtx.stepUps.insert({ sessionId, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
}
