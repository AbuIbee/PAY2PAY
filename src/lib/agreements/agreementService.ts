import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { logger } from "@/lib/logger";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { Capability } from "@/lib/staff/capabilities";
import type { StaffService } from "@/lib/staff/staffService";
import { CounterpartyMustSignFirstError, ForbiddenError, ScheduleRevisionRequiredError, ValidationError } from "@/lib/errors";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { PageParams } from "@/lib/pagination";
import { computeSchedule, isPastDate } from "./schedule";
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
  /**
   * Agreement workflow remediation: read-only surfacing of `agreement.relationship_id` (already
   * written by DrizzleAgreementRelationshipLinker, but never previously exposed through
   * AgreementRepository/AgreementRecord) — AgreementProgressService uses this to determine whether a
   * funding/payout payment method is already assigned. Null for any agreement never linked to a
   * relationship (every pre-existing agreement, and any created outside the relationship-invitation
   * flow) — callers must treat null as "not applicable," never as "missing."
   */
  relationshipId: string | null;
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
  /** Agreement Lifecycle V2 UAT (Defect 3 — Delete Draft): hard delete, only ever called after AgreementService.deleteDraft's own status/authorization checks. */
  deleteDraft(id: string): Promise<void>;
  /**
   * PRSprint 26 (docs/prsprints/PRSPRINT_26_SEARCH_FILTER_PAGINATION_RECORD_MANAGEMENT.md):
   * `pageParams` is optional so every pre-existing caller (tests, any future admin/batch tooling)
   * keeps its current unbounded behavior unchanged — the customer-facing route
   * (`GET /api/agreements`) always supplies it. Ordered newest-first so pagination is stable across
   * pages even as new agreements are created between requests.
   */
  listForProfile(profileKind: ProfileKind, profileId: string, pageParams?: PageParams): Promise<AgreementRecord[]>;
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
  /**
   * PRSprint 11 (docs/prsprints/PRSPRINT_11_AGREEMENT_VERSIONING_AMENDMENTS_MUTUAL_APPROVAL.md):
   * "Historical agreement versions must remain retrievable" — every version row was already
   * immutable and permanently kept (nothing here ever deletes or overwrites a prior version), but
   * before this PRSprint there was no way to actually list them; only `findById` (a single,
   * already-known id) existed. Ordered oldest-first (`versionNumber` ascending) to read as a
   * natural history.
   */
  listForAgreement(agreementId: string): Promise<AgreementVersionRecord[]>;
  /** Only ever called while the version is unsigned (pre-signature counter loop) — see AgreementService.creditorDecide. */
  updateTerms(
    id: string,
    input: { frequency: PaymentFrequency; feeAllocation: FeeAllocation; terms: AgreementTerms },
  ): Promise<void>;
  recordSignature(id: string, role: PartyRole, signedAt: Date): Promise<void>;
  lock(id: string, input: { documentHash: string; signedAt: Date }): Promise<void>;
  /**
   * Agreement workflow remediation (Problem 2): reviseFirstPaymentDate calls this whenever a
   * schedule revision happens on a version that already carries a partial (not-yet-both-complete)
   * signature — the terms are changing, so any signature already recorded against the old terms no
   * longer applies to the new ones and must not silently survive under the revised schedule. Only
   * ever called pre-lock (an already-`signedAt`-locked version is immutable and never reaches this
   * method — reviseFirstPaymentDate's own status/signedAt guard ensures that).
   */
  clearSignatures(id: string): Promise<void>;
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

/**
 * PRSprint 12 (docs/prsprints/PRSPRINT_12_ELECTRONIC_SIGNATURES_PDFS_IMMUTABLE_RECORDS.md): evidence
 * fields SignatureService captures alongside a signature. Defined here (not imported from
 * signatureService.ts, which already imports from this file) rather than in signatureService.ts, so
 * this file never depends on that one — the same one-way layering AgreementService/AmendmentService
 * already established.
 */
export interface SigningEvidenceInput {
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
}

export interface SigningApplicationResult {
  /** True if this role had already signed this version — the caller (signAgreement) turns this into the existing ValidationError, matching its pre-PRSprint-12 behavior exactly. */
  alreadySigned: boolean;
  bothSigned: boolean;
  documentHash: string | null;
  /** Present only when `evidence` was supplied and this call actually recorded a new signature. */
  signatureEventId: string | null;
}

/**
 * PRSprint 12: single, hand-written multi-table transaction — mirrors
 * AmendmentApplicationRepository's own doc comment in amendmentService.ts and
 * DrizzleAmendmentApplicationRepository's implementation exactly, for the identical reason. Before
 * this, `signAgreement`'s completing signature made 2-4 independent, non-transactional writes
 * (record this role's signature, lock the version, advance the agreement's status twice), and
 * SignatureService made a *fifth*, entirely separate write (the signature_event evidence row) only
 * after all of those had already committed — so a transient failure between any of those steps
 * (the same category of failure PRSprint 11A found in production) could leave the agreement
 * advanced with no evidence row for it, and a retry would then hit "already signed" forever, unable
 * to ever complete. Real implementation (DrizzleSigningApplicationRepository) re-checks the role
 * hasn't already signed *inside* the transaction (closing a concurrent-double-submit race the
 * pre-PRSprint-12 read-then-write pattern was exposed to) and, when evidence is supplied, inserts
 * signature_event in the same transaction as the version/agreement writes it's evidence for.
 */
export interface SigningApplicationRepository {
  applySigningAtomically(input: {
    agreementId: string;
    agreementVersionId: string;
    role: PartyRole;
    signedAt: Date;
    evidence: SigningEvidenceInput | null;
  }): Promise<SigningApplicationResult>;
}

export interface AgreementServiceDeps {
  agreements: AgreementRepository;
  versions: AgreementVersionRepository;
  parties: AgreementPartyRepository;
  scheduleItems: InstallmentScheduleItemRepository;
  profileOwners: ProfileOwnerReader;
  staffService: StaffService;
  audit: AuditService;
  signing: SigningApplicationRepository;
  /**
   * PRSprint 13 (docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md): optional, mirroring
   * PaymentWebhookService's own identical `notifications?`/`profileOwners` precedent — every caller
   * that omits it (most existing tests) is unaffected, and every notification call this class makes
   * is wrapped in its own try/catch (see `notifyParty`) so a notification-layer failure can never
   * fail the agreement-lifecycle transaction it was reporting on.
   */
  notifications?: NotificationService;
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

/**
 * Sprint 14 (docs/sprints/SPRINT_14_Amendments_Hardship.md): exported so `AmendmentService` can
 * validate/compute a proposed amendment's terms through the exact same path the original draft and
 * Sprint 5's own creditor-counter flow already use, rather than duplicating this validation. Purely
 * additive — no existing caller or behavior changes.
 */
export function buildTerms(input: DraftTermsInput): { terms: AgreementTerms; schedule: ScheduleItem[] } {
  requireNonEmpty(input.category, "category");
  requireNonEmpty(input.description, "description");
  requireNonEmpty(input.earlyPayoffTerms, "earlyPayoffTerms");
  requireNonEmpty(input.hardshipRules, "hardshipRules");
  requireNonEmpty(input.partialPaymentRules, "partialPaymentRules");
  requireNonEmpty(input.settlementRules, "settlementRules");
  requireNonEmpty(input.disputeProcedure, "disputeProcedure");

  // PRSprint 17 (docs/prsprints/PRSPRINT_17_PAYMENT_SCHEDULE_MONETARY_MATH.md): Number.isSafeInteger
  // — see schedule.ts's identical hardening rationale, applied consistently at every authoritative
  // monetary-input boundary in this codebase.
  if (!Number.isSafeInteger(input.originalAmountMinorUnits) || input.originalAmountMinorUnits <= 0) {
    throw new ValidationError("originalAmountMinorUnits must be a positive integer.");
  }
  if (!Number.isSafeInteger(input.previousPaymentsMinorUnits) || input.previousPaymentsMinorUnits < 0) {
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
 * (IP, device, consent, auth method, step-up gate). Sprint 6 layers that evidence capture on top of
 * / supersedes this signing path; it is not re-implemented here.
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
    // Agreement Lifecycle V2 UAT (Defect 5 — date picker must not allow a past first payment date):
    // creation-time only. Deliberately does not touch reviseTermsBeforeSignature/amendments/
    // acceptPlan — an already-created draft that ages past its proposed date remains the existing,
    // deliberately-preserved stale-date-at-sign-time mechanism's job (see signAgreementWithEvidence's
    // own isPastDate check), not this one.
    if (isPastDate(terms.firstPaymentDate)) {
      throw new ValidationError("First payment date cannot be in the past.");
    }

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

  /**
   * Agreement Lifecycle V2 UAT (Defect 3 — Delete Draft): a true, irreversible hard delete, only
   * ever available while the agreement is still an unsent, unsigned Draft — never transmitted to
   * the counterparty, no signatures, no payments, no contractual acceptance. Once an agreement
   * leaves "draft" (submitDraft), this is no longer available; cancelAgreement is the corresponding
   * action for a sent-but-unexecuted agreement, which preserves history instead of erasing it.
   * Originator-only (mirrors createDraft's own authorization: whichever party the creator is
   * authorized for).
   */
  async deleteDraft(agreementId: string, actingUserId: string): Promise<void> {
    const agreement = await this.requireAgreement(agreementId);
    this.requireStatus(agreement, "draft");
    const originatorRole = await this.resolvePartyRole(agreementId, agreement.createdByUserId);
    await this.authorizeAsRole(agreement, originatorRole, actingUserId, "create_agreement");
    await this.deps.agreements.deleteDraft(agreementId);
  }

  /**
   * Agreement Lifecycle V2 UAT (Defect 3 — Cancel/Withdraw): for an agreement already sent to the
   * counterparty but not yet Fully Executed — preserves the full audit/version history (never
   * erases anything; mutually_canceled is a terminal status like any other, not a deletion). Either
   * party may cancel while the agreement is still pre-execution: at this stage neither party has a
   * completed contract to be protected from the other unilaterally walking away, mirroring ordinary
   * pre-signature contract negotiation. Every subsequent lifecycle action (submitDraft/
   * acknowledgeDebt/creditorDecide/reviseTermsBeforeSignature/signAgreementWithEvidence) already
   * gates on an exact expected status, so simply leaving the agreement in "mutually_canceled"
   * automatically blocks all of them with no further changes needed — see each of those methods'
   * own status guard.
   */
  async cancelAgreement(agreementId: string, actingUserId: string, reason: string): Promise<AgreementWithDetail> {
    if (!reason.trim()) {
      throw new ValidationError("A reason is required to cancel this agreement.");
    }
    const agreement = await this.requireAgreement(agreementId);
    const role = await this.authorizeEitherParty(agreement, actingUserId, null);
    const cancellableStatuses: AgreementStatus[] = ["awaiting_debtor_acknowledgment", "awaiting_creditor_acceptance", "awaiting_signatures"];
    if (!cancellableStatuses.includes(agreement.status)) {
      throw new ValidationError(
        `This agreement can no longer be cancelled this way — it is "${agreement.status}". A draft may be deleted instead; a fully executed agreement has its own dispute/settlement lifecycle.`,
      );
    }
    // Captured before the status write below — some repository implementations (e.g. the in-memory
    // test fake) mutate the same object `agreement` already points to, which would otherwise make
    // `agreement.status` read back as "mutually_canceled" instead of the real prior status.
    const previousStatus = agreement.status;
    const versionIdAtCancellation = agreement.currentVersionId;
    await this.deps.agreements.updateStatus(agreementId, "mutually_canceled");
    await this.recordAudit(agreementId, actingUserId, "agreement_cancelled", {
      cancelledByRole: role,
      previousStatus,
      versionId: versionIdAtCancellation,
      reason,
    });
    return this.getAgreement(agreementId, actingUserId);
  }

  async submitDraft(agreementId: string, actingUserId: string): Promise<void> {
    const agreement = await this.requireAgreement(agreementId);
    await this.authorizeEitherParty(agreement, actingUserId, null);
    this.requireStatus(agreement, "draft");
    await this.deps.agreements.updateStatus(agreement.id, "awaiting_debtor_acknowledgment");
    const auditId = await this.recordAudit(agreement.id, actingUserId, "agreement_submitted", null);
    await this.notifyParty(agreement, "debtor", "agreement_action_required", { stage: "acknowledge_debt" }, auditId);
  }

  /** FR-AGR-003 — a distinct, attributable event, separate from creation and from signing. */
  async acknowledgeDebt(agreementId: string, actingUserId: string): Promise<void> {
    const agreement = await this.requireAgreement(agreementId);
    await this.authorizeAsRole(agreement, "debtor", actingUserId, null);
    this.requireStatus(agreement, "awaiting_debtor_acknowledgment");
    await this.deps.agreements.updateStatus(agreement.id, "awaiting_creditor_acceptance");
    const auditId = await this.recordAudit(agreement.id, actingUserId, "debtor_acknowledged", null);
    await this.notifyParty(agreement, "creditor", "agreement_action_required", { stage: "decide" }, auditId);
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
      const auditId = await this.recordAudit(agreement.id, input.actingUserId, "creditor_accepted", null);
      await this.notifyParty(agreement, "debtor", "agreement_decided", { decision: "accepted" }, auditId);
      return;
    }

    if (input.decision === "reject") {
      await this.deps.agreements.updateStatus(agreement.id, "draft");
      const auditId = await this.recordAudit(agreement.id, input.actingUserId, "creditor_rejected", { reason: input.reason ?? null });
      await this.notifyParty(agreement, "debtor", "agreement_decided", { decision: "rejected" }, auditId);
      return;
    }

    // counter — delegates to the shared, versioned pre-signature revision path (Agreement Lifecycle
    // V2) rather than mutating the version's terms in place. Kept as a distinct `creditorDecide`
    // input shape for backward API compatibility; see reviseTermsBeforeSignature's own doc comment
    // for why in-place mutation was superseded.
    if (!input.counterTerms) {
      throw new ValidationError("counterTerms is required for a counterproposal.");
    }
    await this.reviseTermsBeforeSignature({
      agreementId: input.agreementId,
      actingUserId: input.actingUserId,
      newTerms: input.counterTerms,
      reason: input.reason ?? "The creditor proposed different terms.",
    });
  }

  /**
   * Agreement Lifecycle V2 (Part 5 — versioning): the single, shared pre-signature negotiation
   * primitive for both parties. Supersedes the old in-place `versions.updateTerms` counter path —
   * "once an agreement has been sent to the other party, material contractual terms may not be
   * silently edited in place... every contractual revision must be associated with an identifiable
   * version." Only the party whose turn it currently is may call this (mirrors
   * acknowledgeDebt/creditorDecide's own role-scoped gates exactly): while
   * `awaiting_debtor_acknowledgment`, only the debtor; while `awaiting_creditor_acceptance`, only the
   * creditor. Creates a new `agreement_version` (never mutates the current one), makes it the
   * agreement's current version, and flips the review stage to the *other* party — the revision loop
   * this class's own doc comment describes. `reason` is this pass's comments mechanism (task's
   * "REVISION COMMENTS" requirement) — audited and surfaced in the UI/PDF, but never itself a
   * contractual amendment; only the new version's terms are.
   */
  async reviseTermsBeforeSignature(input: {
    agreementId: string;
    actingUserId: string;
    newTerms: DraftTermsInput;
    reason: string;
  }): Promise<AgreementWithDetail> {
    if (!input.reason.trim()) {
      throw new ValidationError("A reason is required when proposing revised terms.");
    }
    const agreement = await this.requireAgreement(input.agreementId);
    const revisableStatuses: AgreementStatus[] = ["awaiting_debtor_acknowledgment", "awaiting_creditor_acceptance"];
    if (!revisableStatuses.includes(agreement.status)) {
      throw new ValidationError(
        `Terms can only be revised while the agreement is awaiting review, but it is "${agreement.status}".`,
      );
    }
    // Whose turn it is IS the role permitted to revise right now — mirrors acknowledgeDebt/
    // creditorDecide's own role-scoped authorization for the identical status.
    const actingRole: PartyRole = agreement.status === "awaiting_debtor_acknowledgment" ? "debtor" : "creditor";
    await this.authorizeAsRole(agreement, actingRole, input.actingUserId, null);
    if (!agreement.currentVersionId) {
      throw new ValidationError("This agreement has no current version to revise.");
    }
    const currentVersion = await this.requireVersion(agreement.currentVersionId);
    if (currentVersion.signedAt) {
      throw new ValidationError("This agreement is already fully signed and can no longer be revised this way.");
    }

    const { terms, schedule } = buildTerms(input.newTerms);
    const versionNumber = currentVersion.versionNumber + 1;
    const newVersion = await this.deps.versions.insert({
      agreementId: agreement.id,
      versionNumber,
      parentVersionId: currentVersion.id,
      isOriginal: false,
      producedBy: `${actingRole}_revision`,
      frequency: input.newTerms.frequency,
      feeAllocation: input.newTerms.feeAllocation,
      terms,
    });
    await this.deps.scheduleItems.replaceForVersion(newVersion.id, schedule);
    await this.deps.agreements.setCurrentVersionId(agreement.id, newVersion.id);

    // Flip to the *other* party's review — the revision loop: whoever didn't just propose this
    // change must acknowledge/accept (or revise again) the new version before signing can begin.
    const otherRole: PartyRole = actingRole === "debtor" ? "creditor" : "debtor";
    const nextStatus: AgreementStatus = otherRole === "debtor" ? "awaiting_debtor_acknowledgment" : "awaiting_creditor_acceptance";
    await this.deps.agreements.updateStatus(agreement.id, nextStatus);

    const auditId = await this.recordAudit(agreement.id, input.actingUserId, "agreement_terms_revised", {
      previousVersionId: currentVersion.id,
      previousVersionNumber: currentVersion.versionNumber,
      newVersionId: newVersion.id,
      newVersionNumber: versionNumber,
      proposedByRole: actingRole,
      reason: input.reason,
    });
    await this.notifyParty(agreement, otherRole, "agreement_action_required", { stage: "review_revision", versionNumber }, auditId);

    return this.getAgreement(input.agreementId, input.actingUserId);
  }

  /**
   * Minimal Sprint-5 signing primitive — see this class's doc comment. Once both roles have
   * signed, the version locks (FR-AGR-006) and the agreement auto-advances to
   * first_payment_pending (docs/STATE_MACHINES.md §1: "Signed --> FirstPaymentPending: automatic").
   * A thin wrapper over signAgreementWithEvidence with no evidence to record — see that method for
   * the PRSprint 12 atomicity fix both share. Behavior/errors/audit records are byte-for-byte
   * unchanged from before PRSprint 12.
   */
  async signAgreement(agreementId: string, actingUserId: string): Promise<void> {
    await this.signAgreementWithEvidence(agreementId, actingUserId, null);
  }

  /**
   * PRSprint 12 (docs/prsprints/PRSPRINT_12_ELECTRONIC_SIGNATURES_PDFS_IMMUTABLE_RECORDS.md):
   * SignatureService's entry point — identical validation to signAgreement, but the completing
   * signature's version/agreement writes and (when `evidence` is supplied) the signature_event
   * evidence row are applied in one atomic transaction via `deps.signing`, instead of signAgreement's
   * pre-PRSprint-12 sequence of independent writes followed by a *separate* evidence insert. See
   * SigningApplicationRepository's own doc comment for exactly what risk this closes.
   */
  async signAgreementWithEvidence(
    agreementId: string,
    actingUserId: string,
    evidence: SigningEvidenceInput | null,
  ): Promise<{ signatureEventId: string | null; signedAt: Date; bothSigned: boolean; agreementStatus: AgreementStatus }> {
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
    // Agreement Lifecycle V2: the invited counterparty (whoever did NOT create this agreement) must
    // review, accept, and sign before the originator does — "the agreement is NOT Active yet" after
    // only the counterparty has signed; the originator signs last, after being notified. `createdByUserId`
    // always resolves to a real party role (createDraft requires the creator be authorized for one
    // side), so this never throws for a legitimately-created agreement.
    const originatorRole = await this.resolvePartyRole(agreementId, agreement.createdByUserId);
    if (role === originatorRole) {
      const counterpartySignedAt = originatorRole === "creditor" ? version.debtorSignedAt : version.creditorSignedAt;
      if (!counterpartySignedAt) {
        throw new CounterpartyMustSignFirstError();
      }
    }
    // Closed-beta remediation (Problem 2 — expired first payment date): nothing before this point
    // ever revisits `firstPaymentDate` against the clock once it's computed at draft/counter time, so
    // real-world delay between proposing terms and both parties actually signing can silently carry
    // an already-past date straight into a signed, first_payment_pending agreement. Block *every*
    // signature attempt (not just the completing one) once the date has lapsed — see
    // reviseFirstPaymentDate for the required resolution path — so no party's signature is ever
    // captured against a schedule that's already stale, and no wasted first signature exists to
    // reconcile if the second party is the one who hits this block.
    if (isPastDate(version.terms.firstPaymentDate)) {
      throw new ScheduleRevisionRequiredError(
        `The proposed first payment date (${version.terms.firstPaymentDate}) has already passed. This agreement's schedule must be revised before it can be signed.`,
      );
    }

    const now = new Date();
    const result = await this.deps.signing.applySigningAtomically({
      agreementId: agreement.id,
      agreementVersionId: version.id,
      role,
      signedAt: now,
      evidence,
    });
    // The pre-transaction checks above already reject an already-signed role for the overwhelming
    // common case; this re-check is the transaction's own defense against two requests racing past
    // those checks concurrently (see SigningApplicationRepository's doc comment) — same error text
    // either way, so callers/tests can't tell which check caught it.
    if (result.alreadySigned) {
      throw new ValidationError(
        role === "creditor" ? "The creditor has already signed this agreement." : "The debtor has already signed this agreement.",
      );
    }
    await this.recordAudit(agreement.id, actingUserId, "agreement_signed_by_party", { role });

    if (!result.bothSigned) {
      return { signatureEventId: result.signatureEventId, signedAt: now, bothSigned: false, agreementStatus: agreement.status };
    }

    await this.recordAudit(agreement.id, actingUserId, "agreement_signed", { documentHash: result.documentHash });
    // Automatic per docs/STATE_MACHINES.md §1 — no payment is initiated (Sprint 5 doesn't
    // integrate payments); this is purely a status placeholder for Sprint 9+ to act on later.
    await this.recordAudit(agreement.id, actingUserId, "agreement_first_payment_pending", null);
    return { signatureEventId: result.signatureEventId, signedAt: now, bothSigned: true, agreementStatus: "first_payment_pending" };
  }

  /**
   * Closed-beta remediation (Problem 2 — expired first payment date): the required resolution path
   * for signAgreementWithEvidence's ScheduleRevisionRequiredError. Deliberately narrower than
   * creditorDecide's "counter" mechanism (which only runs from `awaiting_creditor_acceptance` and is
   * creditor-only): this is reachable from `awaiting_signatures` — the exact state a stale date can
   * be discovered in — and either party may propose the new date, since nothing is contractually
   * locked yet (master spec §3: agreements become locked only "after signing") and no counterparty
   * approval is required to revise still-provisional terms pre-signature, mirroring the "counter"
   * flow's own identical "still unsigned, so mutating the version's terms in place is not an
   * FR-AGR-006 violation" precedent. If either party had already signed this version before the date
   * lapsed, that signature is invalidated (clearSignatures) — it was captured against terms that no
   * longer exist — and audited explicitly, rather than silently surviving under the new schedule.
   */
  async reviseFirstPaymentDate(input: {
    agreementId: string;
    actingUserId: string;
    newFirstPaymentDate: string;
  }): Promise<AgreementWithDetail> {
    const agreement = await this.requireAgreement(input.agreementId);
    const revisingRole = await this.authorizeEitherParty(agreement, input.actingUserId, null);
    this.requireStatus(agreement, "awaiting_signatures");
    if (!agreement.currentVersionId) {
      throw new ValidationError("This agreement has no current version to revise.");
    }
    const version = await this.requireVersion(agreement.currentVersionId);
    if (version.signedAt) {
      throw new ValidationError("This agreement is already fully signed and can no longer be revised this way.");
    }
    if (isPastDate(input.newFirstPaymentDate)) {
      throw new ValidationError("The new first payment date must not already be in the past.");
    }

    const previousFirstPaymentDate = version.terms.firstPaymentDate;
    const computed = computeSchedule({
      currentPrincipalMinorUnits: version.terms.currentPrincipalMinorUnits,
      firstPaymentMinorUnits: version.terms.firstPaymentMinorUnits,
      installmentAmountMinorUnits: version.terms.installmentAmountMinorUnits,
      frequency: version.frequency,
      firstPaymentDate: input.newFirstPaymentDate,
    });
    const terms: AgreementTerms = {
      ...version.terms,
      firstPaymentDate: input.newFirstPaymentDate,
      finalPaymentMinorUnits: computed.finalPaymentMinorUnits,
      numberOfInstallments: computed.numberOfInstallments,
    };

    // Agreement Lifecycle V2 (Part 7): a first-payment-date change is a material contractual change
    // like any other, so — same as reviseTermsBeforeSignature — it must create a new version rather
    // than mutate the current one in place. A brand-new version has no signatures on it by
    // construction, so any partial signature on the prior version is invalidated implicitly, not by
    // clearing it after the fact.
    const hadPartialSignature = !!version.creditorSignedAt || !!version.debtorSignedAt;
    const newVersion = await this.deps.versions.insert({
      agreementId: agreement.id,
      versionNumber: version.versionNumber + 1,
      parentVersionId: version.id,
      isOriginal: false,
      producedBy: "first_payment_date_revision",
      frequency: version.frequency,
      feeAllocation: version.feeAllocation,
      terms,
    });
    await this.deps.scheduleItems.replaceForVersion(newVersion.id, computed.items);
    await this.deps.agreements.setCurrentVersionId(agreement.id, newVersion.id);

    await this.recordAudit(agreement.id, input.actingUserId, "agreement_first_payment_date_revised", {
      previousVersionId: version.id,
      previousVersionNumber: version.versionNumber,
      newVersionId: newVersion.id,
      newVersionNumber: newVersion.versionNumber,
      previousFirstPaymentDate,
      newFirstPaymentDate: input.newFirstPaymentDate,
      priorSignatureInvalidated: hadPartialSignature,
    });
    const auditId = await this.recordAudit(agreement.id, input.actingUserId, "agreement_action_required", { stage: "review_revised_schedule" });
    const otherRole: PartyRole = revisingRole === "creditor" ? "debtor" : "creditor";
    await this.notifyParty(agreement, otherRole, "agreement_action_required", { stage: "review_revised_schedule" }, auditId);

    return this.getAgreement(input.agreementId, input.actingUserId);
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

  async listAgreements(actingUserId: string, profile: ProfileRef, pageParams?: PageParams): Promise<AgreementRecord[]> {
    await this.authorizeParty(actingUserId, profile, null);
    return this.deps.agreements.listForProfile(profile.kind, profile.id, pageParams);
  }

  /**
   * PRSprint 11: "historical agreement versions must remain retrievable" — same authorization as
   * `getAgreement` (either party only), returning every version oldest-first rather than just the
   * current one.
   */
  async listVersionHistory(agreementId: string, actingUserId: string): Promise<AgreementVersionRecord[]> {
    const agreement = await this.requireAgreement(agreementId);
    await this.authorizeEitherParty(agreement, actingUserId, null);
    return this.deps.versions.listForAgreement(agreementId);
  }

  /**
   * Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md): public wrapper around the
   * existing private authorizeEitherParty, so SignatureService can determine (and confirm
   * authorization for) which role an acting user occupies before running its own step-up/
   * signing-authority gates — without re-implementing this authorization logic. Purely additive;
   * does not change any existing Sprint 5 behavior.
   */
  async resolvePartyRole(agreementId: string, actingUserId: string): Promise<PartyRole> {
    const agreement = await this.requireAgreement(agreementId);
    return this.authorizeEitherParty(agreement, actingUserId, null);
  }

  /**
   * Sprint 14 (docs/sprints/SPRINT_14_Amendments_Hardship.md): public wrapper around the existing
   * private authorizeAsRole, so `AmendmentService` can require the *same* `approve_agreement`
   * capability gate `creditorDecide` already enforces for the original agreement's accept/reject/
   * counter — for a business-staff creditor deciding an amendment, not just "any active staff
   * member" (which `resolvePartyRole` alone would allow). A no-op capability check for a personal
   * creditor or the business's own owner (both already bypass capability checks in
   * `authorizeParty`), matching `creditorDecide`'s own behavior exactly. Purely additive; does not
   * change any existing Sprint 5 behavior.
   */
  async requireCreditorCapability(agreementId: string, actingUserId: string, capability: Capability): Promise<void> {
    const agreement = await this.requireAgreement(agreementId);
    await this.authorizeAsRole(agreement, "creditor", actingUserId, capability);
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

  /**
   * PRSprint 13 (docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md): notifies the given party
   * role's *account owner* (never every business-staff member — mirrors every other cross-service
   * notification call site in this codebase, e.g. PaymentWebhookService.notifyPaymentStatus). Called
   * only after the state-machine write it's reporting on has already committed, and never allowed to
   * fail that write: `deps.notifications` is optional (silently a no-op if absent, matching every
   * other caller's own graceful-degradation precedent) and every call is wrapped in its own
   * try/catch — a notification-layer failure is logged, never thrown, so it can never undo or block
   * the agreement transition it was reporting on.
   */
  private async notifyParty(
    agreement: AgreementRecord,
    role: PartyRole,
    notificationType: "agreement_action_required" | "agreement_decided",
    payload: Record<string, unknown>,
    auditEventId: number,
  ): Promise<void> {
    if (!this.deps.notifications) return;
    try {
      const profile: ProfileRef =
        role === "creditor"
          ? { kind: agreement.creditorProfileKind, id: agreement.creditorProfileId }
          : { kind: agreement.debtorProfileKind, id: agreement.debtorProfileId };
      const recipientUserId = await this.deps.profileOwners.getOwnerUserId(profile.kind, profile.id);
      if (!recipientUserId) return;
      await this.deps.notifications.notify({
        recipientUserId,
        notificationType,
        relatedAgreementId: agreement.id,
        payload,
        dedupeKey: `${notificationType}:${agreement.id}:audit:${auditEventId}:${recipientUserId}`,
      });
    } catch (error) {
      logger.error("agreement_notification_failed", {
        agreementId: agreement.id,
        notificationType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Returns the created audit event's own id — PRSprint 13 uses this as the natural
   * "this specific transition instance" uniqueness marker for its notification dedupeKeys (see
   * `notifyParty`), since an agreement can legitimately cycle through the same statuses multiple
   * times across a multi-round negotiation (each `creditorDecide` counter sends the debtor back to
   * "draft", from which they may `submitDraft` again), so a key scoped only to
   * type+agreement+status would wrongly deduplicate away later, equally-legitimate rounds — the
   * append-only audit trail already gives every call here its own distinct identity for free.
   */
  private async recordAudit(agreementId: string, actorUserId: string, action: string, newValue: unknown): Promise<number> {
    const event = await this.deps.audit.record({
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
    return event.id;
  }
}
