import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import type { PartyRole } from "@/lib/agreements/agreementService";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { AmendmentService } from "@/lib/amendments/amendmentService";
import { InMemoryAmendmentApplicationRepository, InMemoryAmendmentRepository } from "@/lib/amendments/testFakes";
import { EvidenceService } from "@/lib/evidence/evidenceService";
import { BasicFileValidator } from "@/lib/evidence/fileValidator";
import { InMemoryEvidenceRepository } from "@/lib/evidence/testFakes";
import { InMemoryDocumentStorage } from "@/lib/documents/testFakes";
import { createTestLedgerService, InMemoryAgreementTermsReader } from "@/lib/ledger/testFakes";
import { BalanceService } from "@/lib/ledger/balanceService";
import { createTestPaymentService } from "@/lib/payments/testFakes";
import type { PaymentMethod } from "@/lib/payments/paymentService";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import { AgreementDisputeService } from "./agreementDisputeService";
import type { AgreementDisputeCategory, AgreementDisputeRecord, AgreementDisputeRepository } from "./agreementDisputeService";
import { PaymentDisputeService } from "./paymentDisputeService";
import type {
  IdentityVerificationReferenceReader,
  MandateReferenceReader,
  PaymentDisputeCategory,
  PaymentDisputeRecord,
  PaymentDisputeRepository,
  SignatureReferenceReader,
} from "./paymentDisputeService";

/** Test-only in-memory double for AgreementDisputeRepository, mirroring src/lib/amendments/testFakes.ts's pattern. */
export class InMemoryAgreementDisputeRepository implements AgreementDisputeRepository {
  byId = new Map<string, AgreementDisputeRecord>();

  async insert(input: {
    agreementId: string;
    category: AgreementDisputeCategory;
    explanation: string;
    raisedByRole: PartyRole;
    raisedByProfileKind: ProfileKind;
    raisedByProfileId: string;
    raisedByUserId: string;
  }): Promise<AgreementDisputeRecord> {
    const now = new Date();
    const record: AgreementDisputeRecord = {
      id: randomUUID(),
      status: "opened",
      response: null,
      respondedByUserId: null,
      respondedAt: null,
      resolutionNotes: null,
      resolvedAt: null,
      resultingAmendmentId: null,
      restrictedReason: null,
      restrictedByUserId: null,
      restrictedAt: null,
      restrictionLiftedAt: null,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<AgreementDisputeRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForAgreement(agreementId: string): Promise<AgreementDisputeRecord[]> {
    return [...this.byId.values()]
      .filter((d) => d.agreementId === agreementId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private mustFind(id: string): AgreementDisputeRecord {
    const record = this.byId.get(id);
    if (!record) throw new Error("agreement_dispute not found");
    return record;
  }

  async recordResponse(id: string, input: { response: string; respondedByUserId: string }): Promise<AgreementDisputeRecord> {
    const record = this.mustFind(id);
    record.status = "under_review";
    record.response = input.response;
    record.respondedByUserId = input.respondedByUserId;
    record.respondedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordResolvedNoChange(id: string, resolutionNotes: string | null): Promise<AgreementDisputeRecord> {
    const record = this.mustFind(id);
    record.status = "resolved_no_change";
    record.resolutionNotes = resolutionNotes;
    record.resolvedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordResolvedWithAmendment(id: string, resultingAmendmentId: string): Promise<AgreementDisputeRecord> {
    const record = this.mustFind(id);
    record.status = "resolved_with_amendment";
    record.resultingAmendmentId = resultingAmendmentId;
    record.resolvedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordRestricted(id: string, input: { reason: string; restrictedByUserId: string }): Promise<AgreementDisputeRecord> {
    const record = this.mustFind(id);
    record.status = "restricted";
    record.restrictedReason = input.reason;
    record.restrictedByUserId = input.restrictedByUserId;
    record.restrictedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordRestrictionLifted(id: string, target: "under_review" | "closed"): Promise<AgreementDisputeRecord> {
    const record = this.mustFind(id);
    record.status = target;
    record.restrictionLiftedAt = new Date();
    if (target === "closed") record.closedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }

  async recordClosed(id: string, resolutionNotes: string | null): Promise<AgreementDisputeRecord> {
    const record = this.mustFind(id);
    record.status = "closed";
    record.resolutionNotes = resolutionNotes;
    record.closedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }
}

class InMemoryAuditEventRepositoryForDisputes implements AuditEventRepository {
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
 * Full Sprint 16 agreement-dispute test context, sharing one AgreementService instance set with the
 * underlying test fakes — exactly as production does (AmendmentService/EvidenceService both resolve
 * through the same getAgreementService() singleton) — mirroring src/lib/evidence/testFakes.ts's
 * createTestEvidenceWitnessContext's identical shared-context pattern.
 */
export function createTestAgreementDisputeService() {
  const agreementCtx = createTestAgreementService();

  const amendments = new InMemoryAmendmentRepository();
  const amendmentAuditRepo = new InMemoryAuditEventRepositoryForDisputes();
  const amendmentService = new AmendmentService({
    agreementService: agreementCtx.agreementService,
    amendments,
    versions: agreementCtx.versions,
    application: new InMemoryAmendmentApplicationRepository({
      versions: agreementCtx.versions,
      agreements: agreementCtx.agreements,
      scheduleItems: agreementCtx.scheduleItems,
      amendments,
    }),
    audit: new AuditService(amendmentAuditRepo),
  });

  const evidence = new InMemoryEvidenceRepository();
  const evidenceAuditRepo = new InMemoryAuditEventRepositoryForDisputes();
  const evidenceService = new EvidenceService({
    agreementService: agreementCtx.agreementService,
    evidence,
    witnesses: { isActiveWitness: async () => false },
    storage: new InMemoryDocumentStorage(),
    fileValidator: new BasicFileValidator(),
    audit: new AuditService(evidenceAuditRepo),
  });

  const disputes = new InMemoryAgreementDisputeRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForDisputes();
  const agreementDisputeService = new AgreementDisputeService({
    agreementService: agreementCtx.agreementService,
    amendmentService,
    evidenceService,
    disputes,
    audit: new AuditService(auditRepo),
  });

  return { agreementCtx, amendmentService, amendments, evidenceService, evidence, disputes, auditRepo, agreementDisputeService };
}

/** Test-only in-memory double for PaymentDisputeRepository. */
export class InMemoryPaymentDisputeRepository implements PaymentDisputeRepository {
  byId = new Map<string, PaymentDisputeRecord>();

  async insert(input: {
    paymentAttemptId: string;
    category: PaymentDisputeCategory;
    explanation: string;
    claimedByProfileKind: ProfileKind;
    claimedByProfileId: string;
    claimedByUserId: string;
    preservedMandateReference: string | null;
    preservedSignatureReference: string | null;
    preservedIdentityVerificationReference: string | null;
    ipAddress: string | null;
    deviceInfo: unknown;
  }): Promise<PaymentDisputeRecord> {
    const now = new Date();
    const record: PaymentDisputeRecord = {
      id: randomUUID(),
      status: "claimed",
      claimedAt: now,
      resolutionNotes: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<PaymentDisputeRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForPaymentAttempt(paymentAttemptId: string): Promise<PaymentDisputeRecord[]> {
    return [...this.byId.values()]
      .filter((d) => d.paymentAttemptId === paymentAttemptId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async recordResolution(
    id: string,
    input: { status: "upheld" | "denied"; resolutionNotes: string | null; resolvedByUserId: string },
  ): Promise<PaymentDisputeRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("payment_dispute not found");
    record.status = input.status;
    record.resolutionNotes = input.resolutionNotes;
    record.resolvedByUserId = input.resolvedByUserId;
    record.resolvedAt = new Date();
    record.updatedAt = new Date();
    return record;
  }
}

/**
 * Test-only settable double covering MandateReferenceReader + SignatureReferenceReader — the two
 * "preserve" readers whose findX signatures don't collide (different method names), so one class can
 * safely implement both. IdentityVerificationReferenceReader is deliberately a separate class below,
 * since its own `findReference(profileKind, profileId)` would otherwise collide with this class's
 * differently-shaped `findReference` if merged into one.
 */
export class InMemoryMandateAndSignatureReader implements MandateReferenceReader, SignatureReferenceReader {
  private mandateByAgreement = new Map<string, string>();
  private signatureByAgreementAndProfile = new Map<string, string>();

  setMandateReference(agreementId: string, reference: string): void {
    this.mandateByAgreement.set(agreementId, reference);
  }

  setSignatureReference(agreementId: string, profileKind: ProfileKind, profileId: string, reference: string): void {
    this.signatureByAgreementAndProfile.set(`${agreementId}:${profileKind}:${profileId}`, reference);
  }

  async findActiveReference(agreementId: string, _paymentMethod: PaymentMethod | null): Promise<string | null> {
    return this.mandateByAgreement.get(agreementId) ?? null;
  }

  async findReference(agreementId: string, payerProfileKind: ProfileKind, payerProfileId: string): Promise<string | null> {
    return this.signatureByAgreementAndProfile.get(`${agreementId}:${payerProfileKind}:${payerProfileId}`) ?? null;
  }
}

/** Test-only settable double for IdentityVerificationReferenceReader — kept separate from InMemoryMandateAndSignatureReader; see that class's doc comment for why. */
export class InMemoryIdentityVerificationReader implements IdentityVerificationReferenceReader {
  private identityByProfile = new Map<string, string>();

  setIdentityVerificationReference(profileKind: ProfileKind, profileId: string, reference: string): void {
    this.identityByProfile.set(`${profileKind}:${profileId}`, reference);
  }

  async findReference(profileKind: ProfileKind, profileId: string): Promise<string | null> {
    return this.identityByProfile.get(`${profileKind}:${profileId}`) ?? null;
  }
}

class InMemoryAuditEventRepositoryForPaymentDisputes implements AuditEventRepository {
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
 * Full Sprint 16 payment-dispute test context, sharing one PaymentService instance set and one
 * LedgerService instance set with the underlying test fakes — exactly as production does — plus a
 * BalanceService wired to the same ledger context, so a test can assert a claim's ledger/balance
 * impact end-to-end without re-deriving Sprint 10's own machinery.
 */
export function createTestPaymentDisputeService() {
  const paymentCtx = createTestPaymentService();
  const ledgerCtx = createTestLedgerService();
  const terms = new InMemoryAgreementTermsReader();
  const balanceService = new BalanceService({ ledger: ledgerCtx.ledgerService, terms });

  const disputes = new InMemoryPaymentDisputeRepository();
  const mandatesAndSignatures = new InMemoryMandateAndSignatureReader();
  const identityVerifications = new InMemoryIdentityVerificationReader();
  const auditRepo = new InMemoryAuditEventRepositoryForPaymentDisputes();

  const paymentDisputeService = new PaymentDisputeService({
    payments: paymentCtx.payments,
    disputes,
    ledger: ledgerCtx.ledgerService,
    profileOwners: paymentCtx.verificationCtx.profileOwners,
    mandates: mandatesAndSignatures,
    signatures: mandatesAndSignatures,
    identityVerifications,
    audit: new AuditService(auditRepo),
  });

  return { paymentCtx, ledgerCtx, terms, balanceService, disputes, mandatesAndSignatures, identityVerifications, auditRepo, paymentDisputeService };
}
