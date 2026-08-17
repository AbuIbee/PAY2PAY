import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemoryProfileOwnerReader } from "@/lib/profiles/testFakes";
import { createTestStaffService } from "@/lib/staff/testFakes";
import { AgreementService } from "./agreementService";
import { computeVersionHash } from "./documentHash";
import type {
  AgreementPartyRepository,
  AgreementRecord,
  AgreementRepository,
  AgreementStatus,
  AgreementVersionRecord,
  AgreementVersionRepository,
  FeeAllocation,
  InstallmentScheduleItemRepository,
  PartyRole,
  SigningApplicationRepository,
  SigningApplicationResult,
} from "./agreementService";
import type { PaymentFrequency, ScheduleItem } from "./schedule";
import type { AgreementTerms } from "./agreementService";
import type { ProfileKind } from "@/lib/profiles/verificationService";

/**
 * PRSprint 12 (docs/prsprints/PRSPRINT_12_ELECTRONIC_SIGNATURES_PDFS_IMMUTABLE_RECORDS.md):
 * structural shape matching signatureService.ts's own `SignatureEventRecord` field-for-field, without
 * importing it — signatures/testFakes.ts already imports *from* this file (createTestAgreementService),
 * so the reverse import would be circular. signatures/testFakes.ts passes its own
 * InMemorySignatureEventRepository.events array here directly; TypeScript's structural typing accepts
 * it without either file needing to know the other's concrete type.
 */
export interface InMemorySignatureEventLike {
  id: string;
  agreementVersionId: string;
  signerUserId: string;
  signerProfileKind: ProfileKind;
  signerProfileId: string;
  signerRole: PartyRole;
  signingAuthority: "account_owner" | "authorized_representative" | null;
  signerTitle: string | null;
  consentCaptured: boolean;
  consentVersion: string;
  authMethod: "totp" | "sms";
  ipAddress: string;
  deviceInfo: unknown;
  timezone: string;
  agreementHashAtSigning: string;
  signedAt: Date;
}

/** Test-only in-memory doubles for AgreementService, mirroring src/lib/auth/testFakes.ts's pattern. */

export class InMemoryAgreementRepository implements AgreementRepository {
  byId = new Map<string, AgreementRecord>();

  async insert(input: {
    creditorProfileKind: ProfileKind;
    creditorProfileId: string;
    debtorProfileKind: ProfileKind;
    debtorProfileId: string;
    currency: string;
    createdByUserId: string;
  }): Promise<AgreementRecord> {
    const record: AgreementRecord = {
      id: randomUUID(),
      status: "draft",
      country: "US",
      currentVersionId: null,
      createdAt: new Date(),
      closedAt: null,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<AgreementRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async updateStatus(id: string, status: AgreementStatus): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.status = status;
  }

  async setCurrentVersionId(id: string, versionId: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.currentVersionId = versionId;
  }

  async listForProfile(profileKind: ProfileKind, profileId: string): Promise<AgreementRecord[]> {
    return [...this.byId.values()].filter(
      (a) =>
        (a.creditorProfileKind === profileKind && a.creditorProfileId === profileId) ||
        (a.debtorProfileKind === profileKind && a.debtorProfileId === profileId),
    );
  }
}

export class InMemoryAgreementVersionRepository implements AgreementVersionRepository {
  byId = new Map<string, AgreementVersionRecord>();

  async insert(input: {
    agreementId: string;
    versionNumber: number;
    parentVersionId: string | null;
    isOriginal: boolean;
    producedBy: string;
    frequency: PaymentFrequency;
    feeAllocation: FeeAllocation;
    terms: AgreementTerms;
  }): Promise<AgreementVersionRecord> {
    const record: AgreementVersionRecord = {
      id: randomUUID(),
      documentHash: null,
      creditorSignedAt: null,
      debtorSignedAt: null,
      signedAt: null,
      createdAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<AgreementVersionRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForAgreement(agreementId: string): Promise<AgreementVersionRecord[]> {
    return [...this.byId.values()]
      .filter((v) => v.agreementId === agreementId)
      .sort((a, b) => a.versionNumber - b.versionNumber);
  }

  async updateTerms(
    id: string,
    input: { frequency: PaymentFrequency; feeAllocation: FeeAllocation; terms: AgreementTerms },
  ): Promise<void> {
    const record = this.byId.get(id);
    if (record) {
      record.frequency = input.frequency;
      record.feeAllocation = input.feeAllocation;
      record.terms = input.terms;
    }
  }

  async recordSignature(id: string, role: PartyRole, signedAt: Date): Promise<void> {
    const record = this.byId.get(id);
    if (!record) return;
    if (role === "creditor") record.creditorSignedAt = signedAt;
    else record.debtorSignedAt = signedAt;
  }

  async lock(id: string, input: { documentHash: string; signedAt: Date }): Promise<void> {
    const record = this.byId.get(id);
    if (record) {
      record.documentHash = input.documentHash;
      record.signedAt = input.signedAt;
    }
  }
}

/**
 * PRSprint 12: mirrors InMemoryAmendmentApplicationRepository's own doc comment/pattern exactly —
 * this fake's own "atomicity" isn't the thing under test (in-process JS has no partial-commit
 * scenario to simulate); it exists so every existing assertion that reads `ctx.versions`/
 * `ctx.agreements` directly keeps seeing the same shared, already-established in-memory state, by
 * delegating to those same repositories' own existing mutation logic in the identical sequence the
 * production DrizzleSigningApplicationRepository performs inside its single transaction.
 */
export class InMemorySigningApplicationRepository implements SigningApplicationRepository {
  constructor(
    private readonly versions: InMemoryAgreementVersionRepository,
    private readonly agreements: InMemoryAgreementRepository,
    /**
     * Public (unlike this class's other constructor params) so a caller that built its own separate
     * SignatureService context sharing this same AgreementService (e.g. b2bWorkflowService.test.ts)
     * can point its own SignatureEventRepository fake's `.events` array at this exact array, instead
     * of constructing an unconnected one that would never see what this atomic apply writes.
     */
    public readonly signatureEvents: InMemorySignatureEventLike[] = [],
  ) {}

  async applySigningAtomically(input: {
    agreementId: string;
    agreementVersionId: string;
    role: PartyRole;
    signedAt: Date;
    evidence: {
      signerUserId: string;
      signerProfileKind: ProfileKind;
      signerProfileId: string;
      signerRole: PartyRole;
      signingAuthority: "account_owner" | "authorized_representative" | null;
      signerTitle: string | null;
      consentCaptured: boolean;
      consentVersion: string;
      authMethod: "totp" | "sms";
      ipAddress: string;
      deviceInfo: unknown;
      timezone: string;
      agreementHashAtSigning: string;
    } | null;
  }): Promise<SigningApplicationResult> {
    const version = this.versions.byId.get(input.agreementVersionId);
    if (!version) throw new Error("agreement_version not found during atomic signing apply");
    const alreadySigned = input.role === "creditor" ? version.creditorSignedAt !== null : version.debtorSignedAt !== null;
    if (alreadySigned) {
      return { alreadySigned: true, bothSigned: false, documentHash: null, signatureEventId: null };
    }

    await this.versions.recordSignature(input.agreementVersionId, input.role, input.signedAt);

    let signatureEventId: string | null = null;
    if (input.evidence) {
      const record: InMemorySignatureEventLike = { id: randomUUID(), agreementVersionId: input.agreementVersionId, signedAt: input.signedAt, ...input.evidence };
      this.signatureEvents.push(record);
      signatureEventId = record.id;
    }

    const refreshed = this.versions.byId.get(input.agreementVersionId)!;
    const bothSigned =
      (input.role === "creditor" || refreshed.creditorSignedAt !== null) &&
      (input.role === "debtor" || refreshed.debtorSignedAt !== null);
    if (!bothSigned) {
      return { alreadySigned: false, bothSigned: false, documentHash: null, signatureEventId };
    }

    const documentHash = computeVersionHash(refreshed);
    await this.versions.lock(input.agreementVersionId, { documentHash, signedAt: input.signedAt });
    await this.agreements.updateStatus(input.agreementId, "signed");
    await this.agreements.updateStatus(input.agreementId, "first_payment_pending");

    return { alreadySigned: false, bothSigned: true, documentHash, signatureEventId };
  }
}

export class InMemoryAgreementPartyRepository implements AgreementPartyRepository {
  rows: { agreementId: string; role: PartyRole; profileKind: ProfileKind; profileId: string }[] = [];

  async insert(input: { agreementId: string; role: PartyRole; profileKind: ProfileKind; profileId: string }): Promise<void> {
    this.rows.push(input);
  }
}

export class InMemoryInstallmentScheduleItemRepository implements InstallmentScheduleItemRepository {
  byVersionId = new Map<string, ScheduleItem[]>();

  async replaceForVersion(versionId: string, items: ScheduleItem[]): Promise<void> {
    this.byVersionId.set(versionId, items);
  }

  async listForVersion(versionId: string): Promise<ScheduleItem[]> {
    return this.byVersionId.get(versionId) ?? [];
  }
}

class InMemoryAuditEventRepositoryForAgreements implements AuditEventRepository {
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
 * `signatureEvents`: optional shared sink for signature_event-shaped evidence rows written by the
 * atomic signing path — signatures/testFakes.ts's own createTestSignatureService passes its
 * InMemorySignatureEventRepository.events array here so SignatureService's reads (generatePdf's
 * listForVersion, and signatureService.test.ts's own assertions) see the evidence the atomic apply
 * just wrote. Defaults to a private, throwaway array for every caller (e.g. agreementService.test.ts)
 * that never supplies evidence and doesn't care where it would go.
 */
/** `notifications`: optional (PRSprint 13, docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md) — AgreementServiceDeps.notifications is itself optional, matching every other test context's identical pattern; most callers omit it. */
export function createTestAgreementService(
  signatureEvents: InMemorySignatureEventLike[] = [],
  notifications?: import("@/lib/notify/notificationService").NotificationService,
) {
  const agreements = new InMemoryAgreementRepository();
  const versions = new InMemoryAgreementVersionRepository();
  const parties = new InMemoryAgreementPartyRepository();
  const scheduleItems = new InMemoryInstallmentScheduleItemRepository();
  const profileOwners = new InMemoryProfileOwnerReader();
  const staffCtx = createTestStaffService();
  const auditRepo = new InMemoryAuditEventRepositoryForAgreements();
  const audit = new AuditService(auditRepo);
  const signing = new InMemorySigningApplicationRepository(versions, agreements, signatureEvents);

  const agreementService = new AgreementService({
    agreements,
    versions,
    parties,
    scheduleItems,
    profileOwners,
    staffService: staffCtx.staffService,
    audit,
    signing,
    notifications,
  });

  return { agreementService, agreements, versions, parties, scheduleItems, profileOwners, staffCtx, auditRepo, signing };
}
