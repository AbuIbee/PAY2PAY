import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { ConflictError, CounterpartyMustSignFirstError, ScheduleRevisionRequiredError } from "@/lib/errors";
import type { PageParams } from "@/lib/pagination";
import { InMemoryProfileOwnerReader } from "@/lib/profiles/testFakes";
import { createTestStaffService } from "@/lib/staff/testFakes";
import { AgreementService } from "./agreementService";
import { AgreementIdentitySnapshotService } from "./agreementIdentitySnapshotService";
import type {
  AgreementPartySnapshotRecord,
  AgreementPartySnapshotRepository,
  PartyIdentitySnapshotFields,
  PartyIdentitySource,
} from "./agreementIdentitySnapshotService";
import { computeVersionHash } from "./documentHash";
import type {
  AgreementPartyNameReader,
  AgreementPartyRepository,
  AgreementRecord,
  AgreementRepository,
  AgreementStatus,
  AgreementVersionRecord,
  AgreementVersionRepository,
  FeeAllocation,
  InstallmentScheduleItemRepository,
  PartyRole,
  RevisionApplicationRepository,
  RevisionApplicationResult,
  SigningApplicationRepository,
  SigningApplicationResult,
} from "./agreementService";
import { isPastDate } from "./schedule";
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
      relationshipId: null,
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

  /** R05: mirrors DrizzleAgreementRepository's identical conditional-write contract — see its own doc comment. */
  async updateStatusIfCurrentlyIn(id: string, expectedStatuses: readonly AgreementStatus[], newStatus: AgreementStatus): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record || !expectedStatuses.includes(record.status)) return false;
    record.status = newStatus;
    return true;
  }

  /** FINAL corrective pass: mirrors `DrizzleAgreementRepository.applyAcceptanceTransitionAtomically`'s status/currentVersionId re-validation contract (no separate version-row-ownership check needed here — there is no untrusted DB state for an in-memory fake to defend against). */
  async applyAcceptanceTransitionAtomically(input: {
    agreementId: string;
    expectedCurrentVersionId: string;
    expectedStatuses: readonly AgreementStatus[];
    newStatus: AgreementStatus;
  }): Promise<boolean> {
    const record = this.byId.get(input.agreementId);
    if (!record) return false;
    if (!input.expectedStatuses.includes(record.status)) return false;
    if (record.currentVersionId !== input.expectedCurrentVersionId) return false;
    record.status = input.newStatus;
    return true;
  }

  async setCurrentVersionId(id: string, versionId: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.currentVersionId = versionId;
  }

  /** Agreement Lifecycle V2 UAT (Defect 3 — Delete Draft): mirrors DrizzleAgreementRepository.deleteDraft's own contract (irreversible, called only after AgreementService.deleteDraft's own checks). */
  async deleteDraft(id: string): Promise<void> {
    this.byId.delete(id);
  }

  async listForProfile(profileKind: ProfileKind, profileId: string, pageParams?: PageParams): Promise<AgreementRecord[]> {
    const matches = [...this.byId.values()]
      .filter(
        (a) =>
          (a.creditorProfileKind === profileKind && a.creditorProfileId === profileId) ||
          (a.debtorProfileKind === profileKind && a.debtorProfileId === profileId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (!pageParams) return matches;
    return matches.slice(pageParams.offset, pageParams.offset + pageParams.limit);
  }

  async listByRelationshipId(relationshipId: string): Promise<AgreementRecord[]> {
    return [...this.byId.values()]
      .filter((a) => a.relationshipId === relationshipId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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

  async clearSignatures(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) {
      record.creditorSignedAt = null;
      record.debtorSignedAt = null;
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
    originatorRole: PartyRole;
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
    } | null;
  }): Promise<SigningApplicationResult> {
    // R05 (DB integrity & concurrency hardening): mirrors DrizzleSigningApplicationRepository's own
    // re-validation contract — see that class's doc comment. No separate lock needed here: every
    // read this method performs (the checks below) is a direct, synchronous Map access with no
    // `await` in between it and this method's own first write — unlike a fallback that reads via one
    // awaited call and writes via a separate, later awaited call (see AuditService.record's own doc
    // comment for exactly that failure shape), there is no suspension point between "read" and
    // "write" here for a second concurrent caller to interleave into. The `await`s below (on other
    // in-memory repositories' own methods) only ever follow this method's own decisive check/write,
    // never precede it, so two "concurrent" `Promise.all` callers against this fake still can never
    // interleave mid-check.
    const agreementRecord = this.agreements.byId.get(input.agreementId);
    if (!agreementRecord) throw new Error("agreement not found during atomic signing apply");
    if (agreementRecord.status !== "awaiting_signatures") {
      throw new ConflictError(
        `This agreement is no longer awaiting signatures (it is now "${agreementRecord.status}") — someone else's action changed it first. Please refresh and try again.`,
      );
    }
    if (agreementRecord.currentVersionId !== input.agreementVersionId) {
      throw new ConflictError(
        "This agreement's terms were revised by another request before your signature could be recorded. Please review the current version and try again.",
      );
    }

    const version = this.versions.byId.get(input.agreementVersionId);
    if (!version) throw new Error("agreement_version not found during atomic signing apply");
    const alreadySigned = input.role === "creditor" ? version.creditorSignedAt !== null : version.debtorSignedAt !== null;
    if (alreadySigned) {
      return { alreadySigned: true, bothSigned: false, documentHash: null, signatureEventId: null, agreementHashAtSigning: null };
    }

    if (input.role === input.originatorRole) {
      const counterpartySignedAt = input.originatorRole === "creditor" ? version.debtorSignedAt : version.creditorSignedAt;
      if (!counterpartySignedAt) {
        throw new CounterpartyMustSignFirstError();
      }
    }
    if (isPastDate(version.terms.firstPaymentDate)) {
      throw new ScheduleRevisionRequiredError(
        `The proposed first payment date (${version.terms.firstPaymentDate}) has already passed. This agreement's schedule must be revised before it can be signed.`,
      );
    }

    await this.versions.recordSignature(input.agreementVersionId, input.role, input.signedAt);

    let signatureEventId: string | null = null;
    let agreementHashAtSigning: string | null = null;
    if (input.evidence) {
      agreementHashAtSigning = computeVersionHash(version);
      const record: InMemorySignatureEventLike = { id: randomUUID(), agreementVersionId: input.agreementVersionId, signedAt: input.signedAt, agreementHashAtSigning, ...input.evidence };
      this.signatureEvents.push(record);
      signatureEventId = record.id;
    }

    const refreshed = this.versions.byId.get(input.agreementVersionId)!;
    const bothSigned =
      (input.role === "creditor" || refreshed.creditorSignedAt !== null) &&
      (input.role === "debtor" || refreshed.debtorSignedAt !== null);
    if (!bothSigned) {
      return { alreadySigned: false, bothSigned: false, documentHash: null, signatureEventId, agreementHashAtSigning };
    }

    const documentHash = computeVersionHash(refreshed);
    await this.versions.lock(input.agreementVersionId, { documentHash, signedAt: input.signedAt });
    await this.agreements.updateStatus(input.agreementId, "signed");
    await this.agreements.updateStatus(input.agreementId, "first_payment_pending");

    return { alreadySigned: false, bothSigned: true, documentHash, signatureEventId, agreementHashAtSigning };
  }
}

/**
 * R07 corrective pass (Codex finding G): mirrors `DrizzleRevisionApplicationRepository`'s real
 * re-validation contract — see that class's own doc comment. No separate lock needed here: every
 * read this method performs is a direct, synchronous Map access with no `await` in between it and
 * this method's own first write (see `InMemorySigningApplicationRepository.applySigningAtomically`'s
 * identical reasoning above), so two "concurrent" `Promise.all` callers against this fake can never
 * interleave mid-check.
 */
export class InMemoryRevisionApplicationRepository implements RevisionApplicationRepository {
  constructor(
    private readonly versions: InMemoryAgreementVersionRepository,
    private readonly agreements: InMemoryAgreementRepository,
    private readonly scheduleItems: InMemoryInstallmentScheduleItemRepository,
  ) {}

  async applyFirstPaymentDateRevisionAtomically(input: {
    agreementId: string;
    baseVersionId: string;
    frequency: PaymentFrequency;
    feeAllocation: FeeAllocation;
    terms: AgreementTerms;
    schedule: ScheduleItem[];
  }): Promise<RevisionApplicationResult> {
    const agreementRecord = this.agreements.byId.get(input.agreementId);
    if (!agreementRecord) throw new Error("agreement not found during atomic revision apply");
    if (agreementRecord.status !== "awaiting_signatures") {
      throw new ConflictError(
        `This agreement is no longer awaiting signatures (it is now "${agreementRecord.status}") — its schedule can no longer be revised this way. Please refresh and try again.`,
      );
    }
    if (agreementRecord.currentVersionId !== input.baseVersionId) {
      throw new ConflictError("This agreement's terms were already revised by another request. Please refresh and try again.");
    }

    const versionRecord = this.versions.byId.get(input.baseVersionId);
    if (!versionRecord) throw new Error("agreement_version not found during atomic revision apply");
    if (versionRecord.agreementId !== input.agreementId) {
      throw new ConflictError("This version does not belong to the specified agreement — refusing to revise.");
    }
    if (versionRecord.signedAt) {
      throw new ConflictError(
        "This agreement was fully signed by another request before this revision could be applied. Please refresh and try again.",
      );
    }

    const newVersion = await this.versions.insert({
      agreementId: input.agreementId,
      versionNumber: versionRecord.versionNumber + 1,
      parentVersionId: versionRecord.id,
      isOriginal: false,
      producedBy: "first_payment_date_revision",
      frequency: input.frequency,
      feeAllocation: input.feeAllocation,
      terms: input.terms,
    });
    await this.scheduleItems.replaceForVersion(newVersion.id, input.schedule);
    await this.agreements.setCurrentVersionId(input.agreementId, newVersion.id);

    return { newVersionId: newVersion.id, newVersionNumber: newVersion.versionNumber };
  }

  /** FINAL corrective pass (Codex): mirrors `DrizzleRevisionApplicationRepository.applyGeneralTermsRevisionAtomically`'s real re-validation contract exactly — see that class's own doc comment. */
  async applyGeneralTermsRevisionAtomically(input: {
    agreementId: string;
    baseVersionId: string;
    expectedStatus: AgreementStatus;
    newStatus: AgreementStatus;
    producedBy: string;
    frequency: PaymentFrequency;
    feeAllocation: FeeAllocation;
    terms: AgreementTerms;
    schedule: ScheduleItem[];
  }): Promise<RevisionApplicationResult> {
    const agreementRecord = this.agreements.byId.get(input.agreementId);
    if (!agreementRecord) throw new Error("agreement not found during atomic revision apply");
    // FINAL corrective pass, round 2: exact status match, not "any generally-revisable status" — see
    // DrizzleRevisionApplicationRepository.applyGeneralTermsRevisionAtomically's own doc comment.
    if (agreementRecord.status !== input.expectedStatus) {
      throw new ConflictError(
        `This agreement is no longer awaiting review in the status it was reviewed against (it is now "${agreementRecord.status}") — someone else's action changed it first. Please refresh and try again.`,
      );
    }
    if (agreementRecord.currentVersionId !== input.baseVersionId) {
      throw new ConflictError("This agreement's terms were already revised by another request. Please refresh and try again.");
    }

    const versionRecord = this.versions.byId.get(input.baseVersionId);
    if (!versionRecord) throw new Error("agreement_version not found during atomic revision apply");
    if (versionRecord.agreementId !== input.agreementId) {
      throw new ConflictError("This version does not belong to the specified agreement — refusing to revise.");
    }
    if (versionRecord.signedAt) {
      throw new ConflictError(
        "This agreement was fully signed by another request before this revision could be applied. Please refresh and try again.",
      );
    }

    const newVersion = await this.versions.insert({
      agreementId: input.agreementId,
      versionNumber: versionRecord.versionNumber + 1,
      parentVersionId: versionRecord.id,
      isOriginal: false,
      producedBy: input.producedBy,
      frequency: input.frequency,
      feeAllocation: input.feeAllocation,
      terms: input.terms,
    });
    await this.scheduleItems.replaceForVersion(newVersion.id, input.schedule);
    await this.agreements.setCurrentVersionId(input.agreementId, newVersion.id);
    await this.agreements.updateStatus(input.agreementId, input.newStatus);

    return { newVersionId: newVersion.id, newVersionNumber: newVersion.versionNumber };
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

/** Decision 7 (identity snapshot): test-only in-memory double for AgreementPartySnapshotRepository. */
export class InMemoryAgreementPartySnapshotRepository implements AgreementPartySnapshotRepository {
  rows: AgreementPartySnapshotRecord[] = [];

  async insert(input: Omit<AgreementPartySnapshotRecord, "id" | "createdAt">): Promise<AgreementPartySnapshotRecord> {
    const record: AgreementPartySnapshotRecord = { ...input, id: randomUUID(), createdAt: new Date() };
    this.rows.push(record);
    return record;
  }

  async findByVersionId(agreementVersionId: string): Promise<AgreementPartySnapshotRecord[]> {
    return this.rows.filter((r) => r.agreementVersionId === agreementVersionId);
  }
}

/**
 * Decision 7: test-only in-memory double for PartyIdentitySource — defaults to plausible values for
 * any profile a test never explicitly configures via `.set(...)`, matching resolvePersonalDisplayName's
 * own real fallback shape.
 */
export class InMemoryPartyIdentitySource implements PartyIdentitySource {
  private byProfile = new Map<string, PartyIdentitySnapshotFields>();

  set(profileKind: ProfileKind, profileId: string, fields: PartyIdentitySnapshotFields): void {
    this.byProfile.set(`${profileKind}:${profileId}`, fields);
  }

  async getPartyIdentity(profileKind: ProfileKind, profileId: string): Promise<PartyIdentitySnapshotFields> {
    return (
      this.byProfile.get(`${profileKind}:${profileId}`) ?? {
        displayName: profileKind === "business" ? "A Paid2You business" : "A Paid2You member",
        firstName: null,
        lastName: null,
        preferredEmail: null,
        city: null,
        state: null,
        postalCode: null,
        country: null,
      }
    );
  }
}

/**
 * Production defect remediation (agreement participation requires a usable name): test-only double for
 * `AgreementPartyNameReader`. `complete` defaults to `true` (every existing test that wires this in but
 * never calls `setIncomplete` keeps passing) — call `setIncomplete(userId)` to simulate a specific
 * user's own personal profile missing first/last name.
 */
export class FakeAgreementPartyNameReader implements AgreementPartyNameReader {
  incompleteUserIds = new Set<string>();

  setIncomplete(userId: string): void {
    this.incompleteUserIds.add(userId);
  }

  setComplete(userId: string): void {
    this.incompleteUserIds.delete(userId);
  }

  async hasRequiredName(actingUserId: string): Promise<boolean> {
    return !this.incompleteUserIds.has(actingUserId);
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
  connectionEstablisher?: import("./agreementService").AgreementConnectionEstablisher,
  identitySnapshotter?: import("./agreementService").AgreementIdentitySnapshotter,
  partyNames?: import("./agreementService").AgreementPartyNameReader,
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
  const revisions = new InMemoryRevisionApplicationRepository(versions, agreements, scheduleItems);

  // Decision 7: every test harness gets a real, working identity-snapshot mechanism by default (no
  // circular-dependency issue, unlike connectionEstablisher below) — a test can still override it, or
  // configure identities via `identitySource.set(...)` / read frozen rows via `snapshots.rows`.
  const snapshotRepo = new InMemoryAgreementPartySnapshotRepository();
  const identitySource = new InMemoryPartyIdentitySource();
  const defaultIdentitySnapshotter = new AgreementIdentitySnapshotService({ snapshots: snapshotRepo, identitySource });

  const agreementService = new AgreementService({
    agreements,
    versions,
    parties,
    scheduleItems,
    profileOwners,
    staffService: staffCtx.staffService,
    audit,
    signing,
    revisions,
    notifications,
    connectionEstablisher,
    identitySnapshotter: identitySnapshotter ?? defaultIdentitySnapshotter,
    partyNames,
  });

  return {
    agreementService,
    agreements,
    versions,
    parties,
    scheduleItems,
    profileOwners,
    staffCtx,
    auditRepo,
    signing,
    snapshotRepo,
    identitySource,
  };
}
