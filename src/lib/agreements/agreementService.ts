import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { Capability } from "@/lib/staff/capabilities";
import type { StaffService } from "@/lib/staff/staffService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import { computeVersionHash } from "./documentHash";
import { computeSchedule } from "./schedule";
import type { PaymentFrequency, ScheduleItem } from "./schedule";

export type AgreementStatus =
  | "draft"
  | "awaiting_debtor_acknowledgment"
  | "awaiting_creditor_acceptance"
  | "awaiting_signatures"
  | "signed"
  | "first_payment_pending"
  | "active"
  | "past_due"
  | "disputed"
  | "paused_by_amendment"
  | "paid_in_full"
  | "settled_in_full"
  | "mutually_canceled"
  | "closed";

export type PartyRole = "creditor" | "debtor";
export type FeeAllocation = "creditor_pays" | "debtor_pays" | "split_evenly";

export interface ProfileRef {
  kind: ProfileKind;
  id: string;
}

export interface AgreementTerms {
  category: string;
  description: string;
  originalAmountMinorUnits: number;
  previousPaymentsMinorUnits: number;
  currentPrincipalMinorUnits: number;
  firstPaymentMinorUnits: number;
  installmentAmountMinorUnits: number;
  firstPaymentDate: string;
  finalPaymentMinorUnits: number;
  numberOfInstallments: number;
  earlyPayoffTerms: string;
  hardshipRules: string;
  partialPaymentRules: string;
  settlementRules: string;
  disputeProcedure: string;
  supportingEvidenceReferences: string[];
}

export interface AgreementRecord {
  id: string;
  creditorProfileKind: ProfileKind;
  creditorProfileId: string;
  debtorProfileKind: ProfileKind;
  debtorProfileId: string;
  status: AgreementStatus;
  currency: string;
  country: string;
  currentVersionId: string | null;
  createdByUserId: string;
  createdAt: Date;
  closedAt: Date | null;
}

export interface AgreementVersionRecord {
  id: string;
  agreementId: string;
  versionNumber: number;
  parentVersionId: string | null;
  isOriginal: boolean;
  producedBy: string;
  frequency: PaymentFrequency;
  feeAllocation: FeeAllocation;
  terms: AgreementTerms;
  documentHash: string | null;
  creditorSignedAt: Date | null;
  debtorSignedAt: Date | null;
  signedAt: Date | null;
  createdAt: Date;
}

/** Real implementation: DrizzleAgreementRepository. */
export interface AgreementRepository {
  insert(input: {
    creditorProfileKind: ProfileKind;
    creditorProfileId: string;
    debtorProfileKind: ProfileKind;
    debtorProfileId: string;
    currency: string;
    createdByUserId: string;
  }): Promise<AgreementRecord>;
  findById(id: string): Promise<AgreementRecord | null>;
  updateStatus(id: string, status: AgreementStatus): Promise<void>;
  setCurrentVersionId(id: string, versionId: string): Promise<void>;
  listForProfile(profileKind: ProfileKind, profileId: string): Promise<AgreementRecord[]>;
}

/** Real implementation: DrizzleAgreementVersionRepository. */
export interface AgreementVersionRepository {
  insert(input: {
    agreementId: string;
    versionNumber: number;
    parentVersionId: string | null;
    isOriginal: boolean;
    producedBy: string;
    frequency: PaymentFrequency;
    feeAllocation: FeeAllocation;
    terms: AgreementTerms;
  }): Promise<AgreementVersionRecord>;
  findById(id: string): Promise<AgreementVersionRecord | null>;
  /** Only ever called while the version is unsigned (pre-signature counter loop) — see AgreementService.creditorDecide. */
  updateTerms(
    id: string,
    input: { frequency: PaymentFrequency; feeAllocation: FeeAllocation; terms: AgreementTerms },
  ): Promise<void>;
  recordSignature(id: string, role: PartyRole, signedAt: Date): Promise<void>;
  lock(id: string, input: { documentHash: string; signedAt: Date }): Promise<void>;
}

/** Real implementation: DrizzleAgreementPartyRepository. */
export interface AgreementPartyRepository {
  insert(input: { agreementId: string; role: PartyRole; profileKind: ProfileKind; profileId: string }): Promise<void>;
}

/** Real implementation: DrizzleInstallmentScheduleItemRepository. */
export interface InstallmentScheduleItemRepository {
  replaceForVersion(versionId: string, items: ScheduleItem[]): Promise<void>;
  listForVersion(versionId: string): Promise<ScheduleItem[]>;
}

export interface AgreementServiceDeps {
  agreements: AgreementRepository;
  versions: AgreementVersionRepository;
  parties: AgreementPartyRepository;
  scheduleItems: InstallmentScheduleItemRepository;
  profileOwners: ProfileOwnerReader;
  staffService: StaffService;
  audit: AuditService;
}

export interface CreateDraftInput {
  creatorUserId: string;
  creditor: ProfileRef;
  debtor: ProfileRef;
  currency?: string;
  category: string;
  description: string;
  originalAmountMinorUnits: number;
  previousPaymentsMinorUnits: number;
  firstPaymentMinorUnits: number;
  installmentAmountMinorUnits: number;
  frequency: PaymentFrequency;
  firstPaymentDate: string;
  feeAllocation: FeeAllocation;
  earlyPayoffTerms: string;
  hardshipRules: string;
  partialPaymentRules: string;
  settlementRules: string;
  disputeProcedure: string;
  supportingEvidenceReferences?: string[];
}

export type DraftTermsInput = Omit<CreateDraftInput, "creatorUserId" | "creditor" | "debtor" | "currency">;

export interface AgreementWithDetail {
  agreement: AgreementRecord;
  version: AgreementVersionRecord;
  schedule: ScheduleItem[];
}

function requireNonEmpty(value: string, fieldName: string): void {
  if (!value.trim()) throw new ValidationError(`${fieldName} is required.`);
}

function buildTerms(input: DraftTermsInput): { terms: AgreementTerms; schedule: ScheduleItem[] } {
  requireNonEmpty(input.category, "category");
  requireNonEmpty(input.description, "description");
  requireNonEmpty(input.earlyPayoffTerms, "earlyPayoffTerms");
  requireNonEmpty(input.hardshipRules, "hardshipRules");
  requireNonEmpty(input.partialPaymentRules, "partialPaymentRules");
  requireNonEmpty(input.settlementRules, "settlementRules");
  requireNonEmpty(input.disputeProcedure, "disputeProcedure");

  if (!Number.isInteger(input.originalAmountMinorUnits) || input.originalAmountMinorUnits <= 0) {
    throw new ValidationError("originalAmountMinorUnits must be a positive integer.");
  }
  if (!Number.isInteger(input.previousPaymentsMinorUnits) || input.previousPaymentsMinorUnits < 0) {
    throw new ValidationError("previousPaymentsMinorUnits must be a non-negative integer.");
  }
  const currentPrincipalMinorUnits = input.originalAmountMinorUnits - input.previousPaymentsMinorUnits;
  if (currentPrincipalMinorUnits < 0) {
    throw new ValidationError("previousPaymentsMinorUnits cannot exceed originalAmountMinorUnits.");
  }

  const computed = computeSchedule({
    currentPrincipalMinorUnits,
    firstPaymentMinorUnits: input.firstPaymentMinorUnits,
    installmentAmountMinorUnits: input.installmentAmountMinorUnits,
    frequency: input.frequency,
    firstPaymentDate: input.firstPaymentDate,
  });

  const terms: AgreementTerms = {
    category: input.category,
    description: input.description,
    originalAmountMinorUnits: input.originalAmountMinorUnits,
    previousPaymentsMinorUnits: input.previousPaymentsMinorUnits,
    currentPrincipalMinorUnits,
    firstPaymentMinorUnits: input.firstPaymentMinorUnits,
    installmentAmountMinorUnits: input.installmentAmountMinorUnits,
    firstPaymentDate: input.firstPaymentDate,
    finalPaymentMinorUnits: computed.finalPaymentMinorUnits,
    numberOfInstallments: computed.numberOfInstallments,
    earlyPayoffTerms: input.earlyPayoffTerms,
    hardshipRules: input.hardshipRules,
    partialPaymentRules: input.partialPaymentRules,
    settlementRules: input.settlementRules,
    disputeProcedure: input.disputeProcedure,
    supportingEvidenceReferences: input.supportingEvidenceReferences ?? [],
  };

  return { terms, schedule: computed.items };
}

/**
 * Sprint 5 (docs/sprints/SPRINT_05_Agreement_Engine.md) canonical repayment-agreement engine.
 * State machine matches docs/STATE_MACHINES.md §1 exactly (same transition graph, this sprint's
 * debtor/creditor vocabulary). No payment integration (this sprint's explicit scope boundary) — the
 * lifecycle stops advancing itself at `first_payment_pending`; `active`/`past_due`/etc. are reserved
 * for Sprint 9+ to drive once real payments exist.
 *
 * Authorization never re-implements Sprint 3/4's primitives: a personal-profile party must be that
 * profile's own account owner (ProfileOwnerReader); a business-profile party must be either the
 * business's owner (ProfileOwnerReader — covers the pre-Sprint-4-staff-row bootstrap gap: no
 * `business_staff_member` row is auto-created when a business profile is created, so the owner
 * always being authorized here is load-bearing, not just a convenience) or an active staff member
 * with the relevant capability (StaffService). create_agreement gates draft creation and
 * approve_agreement gates the creditor's accept/reject/counter decision (FR-B2B-006's named
 * gated actions); debtor acknowledgment and signing have no dedicated capability in Sprint 4's
 * fixed 13-capability list, so any active staff member may perform them.
 *
 * Signing here is a minimal, version-scoped signing-intent primitive (agreement_version.
 * creditor_signed_at/debtor_signed_at) — not Sprint 6's full electronic-signature evidence bundle
 * (IP, device, consent, auth method, step-up, isFullyVerified gate). Sprint 6 layers that evidence
 * capture on top of / supersedes this signing path; it is not re-implemented here.
 */
export class AgreementService {
  constructor(private readonly deps: AgreementServiceDeps) {}

  async createDraft(input: CreateDraftInput): Promise<AgreementWithDetail> {
    if (input.creditor.kind === input.debtor.kind && input.creditor.id === input.debtor.id) {
      throw new ValidationError("An agreement cannot have the same profile as both creditor and debtor.");
    }

    // The creator must be authorized for at least one side of the agreement (FR-AGR-001).
    const creatorIsCreditor = await this.tryAuthorizeParty(input.creatorUserId, input.creditor, "create_agreement");
    const creatorIsDebtor = creatorIsCreditor
      ? false
      : await this.tryAuthorizeParty(input.creatorUserId, input.debtor, "create_agreement");
    if (!creatorIsCreditor && !creatorIsDebtor) {
      throw new ForbiddenError("You are not authorized to create an agreement for either party specified.");
    }

    const { terms, schedule } = buildTerms(input);

    const agreement = await this.deps.agreements.insert({
      creditorProfileKind: input.creditor.kind,
      creditorProfileId: input.creditor.id,
      debtorProfileKind: input.debtor.kind,
      debtorProfileId: input.debtor.id,
      currency: input.currency ?? "USD",
      createdByUserId: input.creatorUserId,
    });

    const version = await this.deps.versions.insert({
      agreementId: agreement.id,
      versionNumber: 1,
      parentVersionId: null,
      isOriginal: true,
      producedBy: "initial_signing",
      frequency: input.frequency,
      feeAllocation: input.feeAllocation,
      terms,
    });

    await this.deps.agreements.setCurrentVersionId(agreement.id, version.id);
    await this.deps.parties.insert({
      agreementId: agreement.id,
      role: "creditor",
      profileKind: input.creditor.kind,
      profileId: input.creditor.id,
    });
    await this.deps.parties.insert({
      agreementId: agreement.id,
      role: "debtor",
      profileKind: input.debtor.kind,
      profileId: input.debtor.id,
    });
    await this.deps.scheduleItems.replaceForVersion(version.id, schedule);

    await this.recordAudit(agreement.id, input.creatorUserId, "agreement_created", {
      relationshipShape: this.relationshipShape(agreement),
    });

    return { agreement: { ...agreement, currentVersionId: version.id }, version, schedule };
  }

  async submitDraft(agreementId: string, actingUserId: string): Promise<void> {
    const agreement = await this.requireAgreement(agreementId);
    await this.authorizeEitherParty(agreement, actingUserId, null);
    this.requireStatus(agreement, "draft");
    await this.deps.agreements.updateStatus(agreement.id, "awaiting_debtor_acknowledgment");
    await this.recordAudit(agreement.id, actingUserId, "agreement_submitted", null);
  }

  /** FR-AGR-003 — a distinct, attributable event, separate from creation and from signing. */
  async acknowledgeDebt(agreementId: string, actingUserId: string): Promise<void> {
    const agreement = await this.requireAgreement(agreementId);
    await this.authorizeAsRole(agreement, "debtor", actingUserId, null);
    this.requireStatus(agreement, "awaiting_debtor_acknowledgment");
    await this.deps.agreements.updateStatus(agreement.id, "awaiting_creditor_acceptance");
    await this.recordAudit(agreement.id, actingUserId, "debtor_acknowledged", null);
  }

  /** FR-AGR-004 — accept/reject/counter, each a distinct, attributable event separate from signing. */
  async creditorDecide(input: {
    agreementId: string;
    actingUserId: string;
    decision: "accept" | "reject" | "counter";
    reason?: string;
    counterTerms?: DraftTermsInput;
  }): Promise<void> {
    const agreement = await this.requireAgreement(input.agreementId);
    await this.authorizeAsRole(agreement, "creditor", input.actingUserId, "approve_agreement");
    this.requireStatus(agreement, "awaiting_creditor_acceptance");

    if (input.decision === "accept") {
      await this.deps.agreements.updateStatus(agreement.id, "awaiting_signatures");
      await this.recordAudit(agreement.id, input.actingUserId, "creditor_accepted", null);
      return;
    }

    if (input.decision === "reject") {
      await this.deps.agreements.updateStatus(agreement.id, "draft");
      await this.recordAudit(agreement.id, input.actingUserId, "creditor_rejected", { reason: input.reason ?? null });
      return;
    }

    // counter — still unsigned, so mutating the version's terms in place is not an FR-AGR-006
    // violation (immutability applies only after signing).
    if (!input.counterTerms) {
      throw new ValidationError("counterTerms is required for a counterproposal.");
    }
    if (!agreement.currentVersionId) {
      throw new ValidationError("This agreement has no current version to counter.");
    }
    const { terms } = buildTerms(input.counterTerms);
    const version = await this.requireVersion(agreement.currentVersionId);
    if (version.signedAt) {
      throw new ValidationError("Cannot counter a signed version.");
    }
    await this.deps.versions.updateTerms(version.id, {
      frequency: input.counterTerms.frequency,
      feeAllocation: input.counterTerms.feeAllocation,
      terms,
    });
    const computed = computeSchedule({
      currentPrincipalMinorUnits: terms.currentPrincipalMinorUnits,
      firstPaymentMinorUnits: terms.firstPaymentMinorUnits,
      installmentAmountMinorUnits: terms.installmentAmountMinorUnits,
      frequency: input.counterTerms.frequency,
      firstPaymentDate: terms.firstPaymentDate,
    });
    await this.deps.scheduleItems.replaceForVersion(version.id, computed.items);
    await this.deps.agreements.updateStatus(agreement.id, "draft");
    await this.recordAudit(agreement.id, input.actingUserId, "creditor_countered", null);
  }

  /**
   * Minimal Sprint-5 signing primitive — see this class's doc comment. Once both roles have
   * signed, the version locks (FR-AGR-006) and the agreement auto-advances to
   * first_payment_pending (docs/STATE_MACHINES.md §1: "Signed --> FirstPaymentPending: automatic").
   */
  async signAgreement(agreementId: string, actingUserId: string): Promise<void> {
    const agreement = await this.requireAgreement(agreementId);
    const role = await this.authorizeEitherParty(agreement, actingUserId, null);
    this.requireStatus(agreement, "awaiting_signatures");
    if (!agreement.currentVersionId) {
      throw new ValidationError("This agreement has no current version to sign.");
    }
    const version = await this.requireVersion(agreement.currentVersionId);
    if (version.signedAt) {
      throw new ValidationError("This agreement is already fully signed.");
    }
    if (role === "creditor" && version.creditorSignedAt) {
      throw new ValidationError("The creditor has already signed this agreement.");
    }
    if (role === "debtor" && version.debtorSignedAt) {
      throw new ValidationError("The debtor has already signed this agreement.");
    }

    const now = new Date();
    await this.deps.versions.recordSignature(version.id, role, now);
    await this.recordAudit(agreement.id, actingUserId, "agreement_signed_by_party", { role });

    const refreshed = await this.requireVersion(version.id);
    const bothSigned =
      (role === "creditor" || refreshed.creditorSignedAt) && (role === "debtor" || refreshed.debtorSignedAt);
    if (!bothSigned) return;

    const documentHash = this.computeDocumentHash(refreshed);
    await this.deps.versions.lock(version.id, { documentHash, signedAt: now });
    await this.deps.agreements.updateStatus(agreement.id, "signed");
    await this.recordAudit(agreement.id, actingUserId, "agreement_signed", { documentHash });

    // Automatic per docs/STATE_MACHINES.md §1 — no payment is initiated (Sprint 5 doesn't
    // integrate payments); this is purely a status placeholder for Sprint 9+ to act on later.
    await this.deps.agreements.updateStatus(agreement.id, "first_payment_pending");
    await this.recordAudit(agreement.id, actingUserId, "agreement_first_payment_pending", null);
  }

  async getAgreement(agreementId: string, actingUserId: string): Promise<AgreementWithDetail> {
    const agreement = await this.requireAgreement(agreementId);
    await this.authorizeEitherParty(agreement, actingUserId, null);
    if (!agreement.currentVersionId) {
      throw new ValidationError("This agreement has no current version.");
    }
    const version = await this.requireVersion(agreement.currentVersionId);
    const schedule = await this.deps.scheduleItems.listForVersion(version.id);
    return { agreement, version, schedule };
  }

  async listAgreements(actingUserId: string, profile: ProfileRef): Promise<AgreementRecord[]> {
    await this.authorizeParty(actingUserId, profile, null);
    return this.deps.agreements.listForProfile(profile.kind, profile.id);
  }

  /**
   * Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md): public wrapper around the
   * existing private authorizeEitherParty, so SignatureService can determine (and confirm
   * authorization for) which role an acting user occupies before running its own step-up/
   * verification/signing-authority gates — without re-implementing this authorization logic.
   * Purely additive; does not change any existing Sprint 5 behavior.
   */
  async resolvePartyRole(agreementId: string, actingUserId: string): Promise<PartyRole> {
    const agreement = await this.requireAgreement(agreementId);
    return this.authorizeEitherParty(agreement, actingUserId, null);
  }

  relationshipShape(agreement: Pick<AgreementRecord, "creditorProfileKind" | "debtorProfileKind">): "P2P" | "B2C" | "C2B" | "B2B" {
    if (agreement.creditorProfileKind === "personal" && agreement.debtorProfileKind === "personal") return "P2P";
    if (agreement.creditorProfileKind === "business" && agreement.debtorProfileKind === "personal") return "B2C";
    if (agreement.creditorProfileKind === "personal" && agreement.debtorProfileKind === "business") return "C2B";
    return "B2B";
  }

  private requireStatus(agreement: AgreementRecord, expected: AgreementStatus): void {
    if (agreement.status !== expected) {
      throw new ValidationError(`This action requires status "${expected}", but the agreement is "${agreement.status}".`);
    }
  }

  private async requireAgreement(agreementId: string): Promise<AgreementRecord> {
    const agreement = await this.deps.agreements.findById(agreementId);
    if (!agreement) throw new ValidationError("Agreement not found.");
    return agreement;
  }

  private async requireVersion(versionId: string): Promise<AgreementVersionRecord> {
    const version = await this.deps.versions.findById(versionId);
    if (!version) throw new ValidationError("Agreement version not found.");
    return version;
  }

  /** Throws ForbiddenError if actingUserId is not authorized for this specific party (role-scoped). */
  private async authorizeAsRole(
    agreement: AgreementRecord,
    role: PartyRole,
    actingUserId: string,
    requiredCapability: Capability | null,
  ): Promise<void> {
    const party =
      role === "creditor"
        ? { kind: agreement.creditorProfileKind, id: agreement.creditorProfileId }
        : { kind: agreement.debtorProfileKind, id: agreement.debtorProfileId };
    await this.authorizeParty(actingUserId, party, requiredCapability);
  }

  /** Returns which role actingUserId is authorized as; throws ForbiddenError if neither. */
  private async authorizeEitherParty(
    agreement: AgreementRecord,
    actingUserId: string,
    requiredCapability: Capability | null,
  ): Promise<PartyRole> {
    if (
      await this.tryAuthorizeParty(
        actingUserId,
        { kind: agreement.creditorProfileKind, id: agreement.creditorProfileId },
        requiredCapability,
      )
    ) {
      return "creditor";
    }
    if (
      await this.tryAuthorizeParty(
        actingUserId,
        { kind: agreement.debtorProfileKind, id: agreement.debtorProfileId },
        requiredCapability,
      )
    ) {
      return "debtor";
    }
    throw new ForbiddenError("You are not a party to this agreement.");
  }

  private async tryAuthorizeParty(
    actingUserId: string,
    party: ProfileRef,
    requiredCapability: Capability | null,
  ): Promise<boolean> {
    try {
      await this.authorizeParty(actingUserId, party, requiredCapability);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Personal: must be the profile's own account owner. Business: the business owner is always
   * authorized (bootstrap gap noted in this class's doc comment); otherwise an active staff member
   * — with `requiredCapability` if one is given, or just active membership if not (debtor
   * acknowledgment and signing have no dedicated capability in Sprint 4's fixed list).
   */
  private async authorizeParty(actingUserId: string, party: ProfileRef, requiredCapability: Capability | null): Promise<void> {
    if (party.kind === "personal") {
      const ownerUserId = await this.deps.profileOwners.getOwnerUserId("personal", party.id);
      if (ownerUserId !== actingUserId) {
        throw new ForbiddenError("You do not have access to this profile.");
      }
      return;
    }

    const ownerUserId = await this.deps.profileOwners.getOwnerUserId("business", party.id);
    if (ownerUserId === actingUserId) return;
    if (requiredCapability) {
      await this.deps.staffService.requireCapability(party.id, actingUserId, requiredCapability);
    } else {
      await this.deps.staffService.requireActiveStaff(party.id, actingUserId);
    }
  }

  private computeDocumentHash(version: AgreementVersionRecord): string {
    return computeVersionHash(version);
  }

  private async recordAudit(agreementId: string, actorUserId: string, action: string, newValue: unknown): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "agreement_party",
      profileKind: null,
      profileId: null,
      agreementId,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
    });
  }
}
