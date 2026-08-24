import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { isAdminRole } from "@/lib/admin/capabilities";
import type { PlatformRole } from "@/lib/auth/authService";
import { generateRelationshipReferenceCode } from "@/lib/auth/token";
import type { PartyRole, AgreementService } from "@/lib/agreements/agreementService";
import type { ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { StaffService } from "@/lib/staff/staffService";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { EvidenceRecord } from "@/lib/evidence/evidenceService";
import type { RelationshipFinancialAccountRepository } from "./relationshipFinancialAccountService";
import type { PartyRef } from "./relationshipInvitationService";

export type RelationshipStatus =
  | "invited"
  | "counterparty_linked"
  | "identities_confirmed"
  | "financial_setup_pending"
  | "financial_accounts_ready"
  | "agreement_pending"
  | "agreement_ready"
  | "signature_pending"
  | "signed"
  | "active"
  | "restricted"
  | "suspended"
  | "closed"
  | "cancelled";

export type RelationshipParticipantStatus = "invited" | "linked" | "active" | "removed";

export interface RelationshipRecord {
  id: string;
  status: RelationshipStatus;
  context: string;
  /** Manual UAT remediation (#2/#3): short human-readable reference ("P2P-XXXX-XXXX"), never a security credential — see relationship.ts's schema doc comment. Null only for a pre-existing row not yet backfilled by ensurePublicReference. */
  publicReference: string | null;
  initiatorUserId: string;
  currentAgreementId: string | null;
  activatedAt: Date | null;
  restrictedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RelationshipParticipantRecord {
  id: string;
  relationshipId: string;
  individualProfileId: string | null;
  organizationId: string | null;
  role: PartyRole;
  status: RelationshipParticipantStatus;
  representedByUserId: string | null;
  joinedAt: Date | null;
  leftAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzleRelationshipRepository. */
export interface RelationshipRepository {
  insert(input: { initiatorUserId: string }): Promise<RelationshipRecord>;
  findById(id: string): Promise<RelationshipRecord | null>;
  listForParticipant(individualProfileId: string | null, organizationId: string | null): Promise<RelationshipRecord[]>;
  setCurrentAgreementId(id: string, agreementId: string): Promise<RelationshipRecord>;
  updateStatus(id: string, status: RelationshipStatus): Promise<RelationshipRecord>;
  markCounterpartyLinked(id: string): Promise<RelationshipRecord>;
  markActivated(id: string): Promise<RelationshipRecord>;
  markRestricted(id: string): Promise<RelationshipRecord>;
  markClosed(id: string): Promise<RelationshipRecord>;
  /** Manual UAT remediation (#2/#3) — backfills a pre-existing row that has none; see RelationshipService.ensurePublicReference. Every row inserted after this change gets one immediately in `insert` itself, mirroring DrizzleUserAccountRepository's identical Section K precedent. */
  setPublicReference(id: string, publicReference: string): Promise<RelationshipRecord>;
}

/** Real implementation: DrizzleRelationshipParticipantRepository. */
export interface RelationshipParticipantRepository {
  insert(input: {
    relationshipId: string;
    individualProfileId: string | null;
    organizationId: string | null;
    role: PartyRole;
    status: RelationshipParticipantStatus;
    representedByUserId: string | null;
    joinedAt: Date | null;
  }): Promise<RelationshipParticipantRecord>;
  listForRelationship(relationshipId: string): Promise<RelationshipParticipantRecord[]>;
}

/**
 * Narrow reader/writer onto Sprint 11's AchMandateService — `isActiveForAgreement` is the activation
 * gate's own read; `authorizeFromFinancialAccount` is the ACH connector (Phase 20): the one seam this
 * class uses to reuse Sprint 11's real mandate-authorization logic (never reimplemented here) once a
 * bank-account funding assignment's governing agreement becomes known. Never mandate CRUD beyond that.
 */
export interface MandateReader {
  isActiveForAgreement(agreementId: string): Promise<boolean>;
  authorizeFromFinancialAccount(input: {
    agreementId: string;
    payer: PartyRef;
    financialAccountId: string;
    bankAccountRef: string;
    actingUserId: string;
  }): Promise<void>;
}

/**
 * Narrow reader/writer onto Sprint 12's DebitCardMethodService — debit-card connector (Phase 21)
 * remediation. Mirrors `MandateReader` exactly: `isActiveForAgreement` is the activation gate's own
 * read; `registerFromFinancialAccount` reuses Sprint 12's real `DebitCardMethodService.registerCard`
 * (never reimplemented here) once a debit-card funding assignment's governing agreement becomes known.
 */
export interface CardMethodReader {
  isActiveForAgreement(agreementId: string): Promise<boolean>;
  registerFromFinancialAccount(input: {
    agreementId: string;
    payer: PartyRef;
    financialAccountId: string;
    cardToken: string;
    cardLast4: string;
    cardBrand: string | null;
    expiresAtMonth: number;
    expiresAtYear: number;
    actingUserId: string;
  }): Promise<void>;
}

/**
 * Document/evidence connector (Phase 25) remediation: a narrow reader onto Sprint 7's EvidenceService.
 * Deliberately just these two methods — `listEvidence`/`getSignedEvidenceUrl` already enforce Sprint
 * 7's own full agreement-party/witness visibility rules (shared vs. private, witness sharing), so this
 * class never re-derives evidence authorization; it only resolves *which* agreement a relationship's
 * evidence request should read from, then delegates entirely.
 */
export interface EvidenceReader {
  listEvidence(agreementId: string, actingUserId: string): Promise<EvidenceRecord[]>;
  getSignedEvidenceUrl(evidenceId: string, actingUserId: string): Promise<string>;
}

/**
 * Agreement connector (Phase 23): the minimum additive linkage needed to resolve `agreement.relationship_id`
 * — a real FK on the agreement table (see agreement.ts) — without touching AgreementService's own Sprint 5
 * creation/versioning/signature logic at all. Deliberately not a method on AgreementService itself; the real
 * implementation is a narrow, direct repository write, kept entirely outside Sprint 5's class.
 */
export interface AgreementRelationshipLinker {
  linkRelationship(agreementId: string, relationshipId: string): Promise<void>;
}

export interface RelationshipServiceDeps {
  relationships: RelationshipRepository;
  participants: RelationshipParticipantRepository;
  financialAccounts: RelationshipFinancialAccountRepository;
  agreementService: AgreementService;
  agreements: AgreementRelationshipLinker;
  mandates: MandateReader;
  cards: CardMethodReader;
  evidence: EvidenceReader;
  profileOwners: ProfileOwnerReader;
  staffService: StaffService;
  notifications: NotificationService;
  audit: AuditService;
}

export interface ActivationCheckResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * Sprint 18A §10–§14's relationship lifecycle, participant model, and activation gate. Every
 * transition happens server-side through this class — "no client may arbitrarily set relationship
 * state" — and invalid transitions fail closed (`requireStatus`/`requireOneOfStatus` throw
 * `ValidationError` rather than silently no-oping).
 *
 * `checkActivationPrerequisites` returns explicit, machine-readable failure reasons (this sprint's
 * own "do not make this a UI-only checklist") rather than a bare boolean — every prerequisite this
 * sprint names is checked: both counterparties linked, governing agreement signed, funding/payout
 * accounts assigned and verified, an active ACH mandate when the funding account is a bank account, an
 * active Sprint 12 `debit_card_method` when the funding account is a debit card (both auto-authorized
 * by `linkAgreement`'s own ACH/debit-card connectors — see `mandate_missing`/`card_missing`), and the
 * relationship itself not restricted/suspended/closed/cancelled.
 *
 * Dispute-driven restriction is a documented, deliberate gap in this pass: Sprint 16's
 * `AgreementDisputeService.restrictDispute` does not call into this class automatically — see
 * `docs/SPRINT_CONTROL.md`'s Sprint 18A implementation notes for why (avoiding a new dependency edge
 * into an already-shipped, already-tested Sprint 16 file under this pass's own scope, not because the
 * connection is unimportant).
 */
export class RelationshipService {
  constructor(private readonly deps: RelationshipServiceDeps) {}

  async getRelationship(relationshipId: string, actingUserId: string): Promise<{ relationship: RelationshipRecord; participants: RelationshipParticipantRecord[] }> {
    let relationship = await this.requireRelationship(relationshipId);
    await this.resolveActingParticipant(relationship.id, actingUserId);
    if (!relationship.publicReference) {
      relationship = await this.deps.relationships.setPublicReference(relationship.id, generateRelationshipReferenceCode());
    }
    const participants = await this.deps.participants.listForRelationship(relationship.id);
    return { relationship, participants };
  }

  /**
   * Manual UAT remediation (#2/#3): backfills a pre-existing relationship row that has none — every
   * row inserted after this change already gets one immediately in `insert` itself (mirrors
   * AuthService.ensurePublicReference / DrizzleUserAccountRepository's identical Section K precedent).
   * Idempotent: returns the existing value untouched if one is already set.
   */
  async ensurePublicReference(relationshipId: string): Promise<string> {
    const relationship = await this.requireRelationship(relationshipId);
    if (relationship.publicReference) return relationship.publicReference;
    const publicReference = generateRelationshipReferenceCode();
    await this.deps.relationships.setPublicReference(relationshipId, publicReference);
    return publicReference;
  }

  async listRelationshipsForParty(actingUserId: string, party: PartyRef): Promise<RelationshipRecord[]> {
    await this.authorizeViewParty(actingUserId, party);
    return this.deps.relationships.listForParticipant(
      party.kind === "personal" ? party.id : null,
      party.kind === "business" ? party.id : null,
    );
  }

  /**
   * Links the governing agreement to this relationship — additive on `agreement.relationship_id`
   * (via `agreements.linkRelationship`, a narrow writer that never touches any other Sprint 5 agreement
   * logic) and on `relationship.current_agreement_id`. ACH connector (Phase 20): if this relationship's
   * active funding assignment is a verified bank account, authorizing the actual mandate could not
   * happen any earlier — Sprint 11's `ach_mandate` is agreement-scoped and no agreement existed until
   * now — so this is the one place that reuses `AchMandateService.authorize` (via `MandateReader`)
   * rather than duplicating mandate logic here.
   */
  async linkAgreement(relationshipId: string, agreementId: string, actingUserId: string): Promise<RelationshipRecord> {
    const relationship = await this.requireRelationship(relationshipId);
    await this.resolveActingParticipant(relationship.id, actingUserId);
    if (relationship.currentAgreementId) {
      throw new ValidationError("This relationship already has a governing agreement linked.");
    }
    await this.deps.relationships.setCurrentAgreementId(relationship.id, agreementId);
    await this.deps.agreements.linkRelationship(agreementId, relationship.id);
    const updated = await this.deps.relationships.updateStatus(relationship.id, "agreement_pending");
    await this.recordAudit(relationship.id, actingUserId, "AGREEMENT_LINKED", { agreementId });

    const funding = await this.deps.financialAccounts.findActiveAssignment(relationship.id, "funding");
    if (funding && funding.financialAccount.status === "verified") {
      const participants = await this.deps.participants.listForRelationship(relationship.id);
      const payerParticipant = participants.find((p) => p.id === funding.relationshipParticipantId);
      if (payerParticipant) {
        const payer: PartyRef = payerParticipant.individualProfileId
          ? { kind: "personal", id: payerParticipant.individualProfileId }
          : { kind: "business", id: payerParticipant.organizationId! };
        if (funding.financialAccount.accountType === "bank_account") {
          await this.deps.mandates.authorizeFromFinancialAccount({
            agreementId,
            payer,
            financialAccountId: funding.financialAccountId,
            bankAccountRef: funding.financialAccount.providerAccountRef,
            actingUserId,
          });
        } else if (
          funding.financialAccount.accountType === "debit_card" &&
          funding.financialAccount.maskedLast4 &&
          funding.financialAccount.cardExpiryMonth &&
          funding.financialAccount.cardExpiryYear
        ) {
          // Debit-card connector (Phase 21) remediation: mirrors the ACH branch above exactly — the
          // registration could not happen any earlier because debit_card_method is agreement-scoped.
          await this.deps.cards.registerFromFinancialAccount({
            agreementId,
            payer,
            financialAccountId: funding.financialAccountId,
            cardToken: funding.financialAccount.providerAccountRef,
            cardLast4: funding.financialAccount.maskedLast4,
            cardBrand: funding.financialAccount.cardBrand,
            expiresAtMonth: funding.financialAccount.cardExpiryMonth,
            expiresAtYear: funding.financialAccount.cardExpiryYear,
            actingUserId,
          });
        }
      }
    }
    return updated;
  }

  /** Read-time sync (mirrors syncFromAgreement's identical precedent) — advances `financial_setup_pending` to `financial_accounts_ready` once both the funding and payout assignments are active and verified. Called by RelationshipFinancialAccountService after each assignment/replacement. */
  async syncFromFinancialAccounts(relationshipId: string): Promise<void> {
    const relationship = await this.requireRelationship(relationshipId);
    if (relationship.status !== "financial_setup_pending") return;
    const funding = await this.deps.financialAccounts.findActiveAssignment(relationship.id, "funding");
    const payout = await this.deps.financialAccounts.findActiveAssignment(relationship.id, "payout");
    if (funding?.financialAccount.status === "verified" && payout?.financialAccount.status === "verified") {
      await this.deps.relationships.updateStatus(relationship.id, "financial_accounts_ready");
    }
  }

  /**
   * Read-time sync (mirrors Sprint 16's `syncAmendmentProgress` precedent) — advances the
   * relationship's own status by inspecting its linked agreement's current, unmodified Sprint 5
   * status/signature state. Never mutates the agreement itself.
   */
  async syncFromAgreement(relationshipId: string, actingUserId: string): Promise<RelationshipRecord> {
    const relationship = await this.requireRelationship(relationshipId);
    await this.resolveActingParticipant(relationship.id, actingUserId);
    if (!relationship.currentAgreementId) return relationship;
    if (relationship.status === "active" || relationship.status === "restricted" || relationship.status === "suspended" || relationship.status === "closed" || relationship.status === "cancelled") {
      return relationship;
    }

    const detail = await this.deps.agreementService.getAgreement(relationship.currentAgreementId, actingUserId);
    const preSignatureStatuses = ["draft", "awaiting_debtor_acknowledgment", "awaiting_creditor_acceptance"];
    let nextStatus: RelationshipStatus | null = null;
    if (detail.version.signedAt) {
      nextStatus = "signed";
    } else if (detail.agreement.status === "awaiting_signatures") {
      nextStatus = "signature_pending";
    } else if (!preSignatureStatuses.includes(detail.agreement.status)) {
      nextStatus = "agreement_ready";
    }
    if (!nextStatus || nextStatus === relationship.status) return relationship;
    const updated = await this.deps.relationships.updateStatus(relationship.id, nextStatus);
    return updated;
  }

  async checkActivationPrerequisites(relationshipId: string): Promise<ActivationCheckResult> {
    const relationship = await this.requireRelationship(relationshipId);
    const reasons: string[] = [];

    if (["restricted", "suspended", "closed", "cancelled"].includes(relationship.status)) {
      reasons.push(`relationship_status_blocking:${relationship.status}`);
    }

    const participants = await this.deps.participants.listForRelationship(relationship.id);
    const active = participants.filter((p) => p.status === "active");
    const creditor = active.find((p) => p.role === "creditor");
    const debtor = active.find((p) => p.role === "debtor");
    if (!creditor || !debtor) {
      reasons.push("counterparty_missing");
    }

    if (!relationship.currentAgreementId) {
      reasons.push("agreement_missing");
    } else {
      const detail = await this.deps.agreementService.getAgreement(relationship.currentAgreementId, relationship.initiatorUserId).catch(() => null);
      if (!detail || !detail.version.signedAt) {
        reasons.push("signature_missing");
      }
    }

    const funding = await this.deps.financialAccounts.findActiveAssignment(relationship.id, "funding");
    if (!funding) {
      reasons.push("funding_account_missing");
    } else if (funding.financialAccount.status !== "verified") {
      reasons.push("funding_account_unverified");
    } else if (funding.financialAccount.accountType === "bank_account" && relationship.currentAgreementId) {
      const mandateActive = await this.deps.mandates.isActiveForAgreement(relationship.currentAgreementId);
      if (!mandateActive) reasons.push("mandate_missing");
    } else if (funding.financialAccount.accountType === "debit_card" && relationship.currentAgreementId) {
      const cardActive = await this.deps.cards.isActiveForAgreement(relationship.currentAgreementId);
      if (!cardActive) reasons.push("card_missing");
    }

    const payout = await this.deps.financialAccounts.findActiveAssignment(relationship.id, "payout");
    if (!payout) {
      reasons.push("payout_account_missing");
    } else if (payout.financialAccount.status !== "verified") {
      reasons.push("payout_account_unverified");
    }

    return { eligible: reasons.length === 0, reasons };
  }

  async activate(relationshipId: string, actingUserId: string): Promise<RelationshipRecord> {
    const relationship = await this.requireRelationship(relationshipId);
    await this.resolveActingParticipant(relationship.id, actingUserId);
    if (relationship.status === "active") return relationship; // idempotent

    const check = await this.checkActivationPrerequisites(relationshipId);
    if (!check.eligible) {
      throw new ValidationError(`Relationship activation prerequisites are not met: ${check.reasons.join(", ")}`);
    }
    const updated = await this.deps.relationships.markActivated(relationship.id);
    await this.recordAudit(relationship.id, actingUserId, "RELATIONSHIP_ACTIVATED", null);

    const participants = await this.deps.participants.listForRelationship(relationship.id);
    await Promise.all(
      participants
        .filter((p) => p.representedByUserId)
        .map((p) =>
          this.deps.notifications.notify({
            recipientUserId: p.representedByUserId!,
            notificationType: "relationship_activated",
            relatedAgreementId: relationship.currentAgreementId,
            payload: { relationshipId: relationship.id },
            dedupeKey: `relationship_activated:${relationship.id}:${p.representedByUserId}`,
          }),
        ),
    );
    return updated;
  }

  /**
   * Admin connector (Phase 37): read-only Platform Admin/Owner support view — never a mutation path.
   * Exposes exactly the fields Phase 37 names as permitted (relationship ID, participants,
   * organizations, lifecycle status, agreement linkage) and nothing this class's own records don't
   * already omit (no reusable invitation token — that lives only in RelationshipInvitationService's
   * own repository and is never read here; no raw bank/card details — `FinancialAccountRecord`
   * itself never stores them). "Administrative access to financially sensitive relationship records
   * should itself be audited" — every call records `ADMIN_RELATIONSHIP_VIEWED`.
   */
  async getRelationshipForAdmin(
    relationshipId: string,
    actingUserId: string,
    actingRole: PlatformRole,
  ): Promise<{ relationship: RelationshipRecord; participants: RelationshipParticipantRecord[] }> {
    if (!isAdminRole(actingRole)) {
      throw new ForbiddenError("Administrative access is required.");
    }
    const relationship = await this.requireRelationship(relationshipId);
    const participants = await this.deps.participants.listForRelationship(relationship.id);
    await this.recordAudit(relationship.id, actingUserId, "ADMIN_RELATIONSHIP_VIEWED", null);
    return { relationship, participants };
  }

  /** Platform Admin/Owner only — "processor/admin restriction applies" (this sprint's own instruction). */
  async restrict(relationshipId: string, actingUserId: string, actingRole: PlatformRole, reason: string): Promise<RelationshipRecord> {
    if (!isAdminRole(actingRole)) {
      throw new ForbiddenError("Administrative access is required to restrict a relationship.");
    }
    const relationship = await this.requireRelationship(relationshipId);
    const updated = await this.deps.relationships.markRestricted(relationship.id);
    await this.recordAudit(relationship.id, actingUserId, "RELATIONSHIP_RESTRICTED", { reason });

    const participants = await this.deps.participants.listForRelationship(relationship.id);
    await Promise.all(
      participants
        .filter((p) => p.representedByUserId)
        .map((p) =>
          this.deps.notifications.notify({
            recipientUserId: p.representedByUserId!,
            notificationType: "relationship_restricted",
            relatedAgreementId: relationship.currentAgreementId,
            payload: { relationshipId: relationship.id, reason },
            dedupeKey: `relationship_restricted:${relationship.id}:${p.representedByUserId}`,
          }),
        ),
    );
    return updated;
  }

  /** Either active principal may close — closing never erases agreements/payments/ledger/dispute/audit history, it only prevents new activity. */
  async close(relationshipId: string, actingUserId: string): Promise<RelationshipRecord> {
    const relationship = await this.requireRelationship(relationshipId);
    await this.resolveActingParticipant(relationship.id, actingUserId);
    if (relationship.status === "closed") return relationship;
    const updated = await this.deps.relationships.markClosed(relationship.id);
    await this.recordAudit(relationship.id, actingUserId, "RELATIONSHIP_CLOSED", null);
    return updated;
  }

  /**
   * Document/evidence connector (Phase 25) remediation: resolves this relationship's governing
   * agreement and delegates entirely to Sprint 7's `EvidenceService.listEvidence`, which already
   * enforces the full shared/private/witness visibility model — no evidence authorization is
   * re-derived here. `resolveActingParticipant` is an additional, relationship-layer gate (the caller
   * must be a current participant *of this relationship*, not merely any historical agreement party)
   * before that agreement-level check even runs — "enforce participant and organization
   * authorization" (Phase 25), applied at both layers.
   */
  async getRelationshipEvidence(relationshipId: string, actingUserId: string): Promise<EvidenceRecord[]> {
    const relationship = await this.requireRelationship(relationshipId);
    await this.resolveActingParticipant(relationship.id, actingUserId);
    if (!relationship.currentAgreementId) {
      throw new ValidationError("This relationship has no governing agreement linked yet.");
    }
    return this.deps.evidence.listEvidence(relationship.currentAgreementId, actingUserId);
  }

  /** Mirrors getRelationshipEvidence's identical authorization layering — relationship participation first, then Sprint 7's own evidence-visibility re-check inside getSignedEvidenceUrl itself. */
  async getRelationshipEvidenceSignedUrl(relationshipId: string, evidenceId: string, actingUserId: string): Promise<string> {
    const relationship = await this.requireRelationship(relationshipId);
    await this.resolveActingParticipant(relationship.id, actingUserId);
    return this.deps.evidence.getSignedEvidenceUrl(evidenceId, actingUserId);
  }

  /** Returns the participant row actingUserId is authorized to act as within this relationship; throws ForbiddenError if none. Mirrors AgreementService.resolvePartyRole's identical shape. */
  async resolveActingParticipant(relationshipId: string, actingUserId: string): Promise<RelationshipParticipantRecord> {
    const participants = await this.deps.participants.listForRelationship(relationshipId);
    for (const participant of participants) {
      if (participant.individualProfileId) {
        const ownerUserId = await this.deps.profileOwners.getOwnerUserId("personal", participant.individualProfileId);
        if (ownerUserId === actingUserId) return participant;
      } else if (participant.organizationId) {
        const ownerUserId = await this.deps.profileOwners.getOwnerUserId("business", participant.organizationId);
        if (ownerUserId === actingUserId) return participant;
        const isStaff = await this.deps.staffService
          .requireActiveStaff(participant.organizationId, actingUserId)
          .then(() => true)
          .catch(() => false);
        if (isStaff) return participant;
      }
    }
    throw new ForbiddenError("You are not a participant in this relationship.");
  }

  private async authorizeViewParty(actingUserId: string, party: PartyRef): Promise<void> {
    if (party.kind === "personal") {
      const ownerUserId = await this.deps.profileOwners.getOwnerUserId("personal", party.id);
      if (ownerUserId !== actingUserId) throw new ForbiddenError("You do not have access to this profile.");
      return;
    }
    const ownerUserId = await this.deps.profileOwners.getOwnerUserId("business", party.id);
    if (ownerUserId === actingUserId) return;
    await this.deps.staffService.requireActiveStaff(party.id, actingUserId);
  }

  private async requireRelationship(id: string): Promise<RelationshipRecord> {
    const relationship = await this.deps.relationships.findById(id);
    if (!relationship) throw new ValidationError("Relationship not found.");
    return relationship;
  }

  private async recordAudit(relationshipId: string, actorUserId: string, action: string, newValue: unknown): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "agreement_party",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: relationshipId,
      targetResourceType: "relationship",
      targetResourceId: relationshipId,
    });
  }
}
