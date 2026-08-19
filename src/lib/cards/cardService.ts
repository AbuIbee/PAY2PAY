import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { Capability } from "@/lib/staff/capabilities";
import type { StaffService } from "@/lib/staff/staffService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileKind, ProfileOwnerReader, VerificationService } from "@/lib/profiles/verificationService";
import type { CardIssuingProvider, CardType } from "./cardIssuingProvider";

export type IssuedCardStatus =
  | "requested"
  | "pending_issuance"
  | "issued"
  | "active"
  | "frozen"
  | "lost"
  | "stolen"
  | "replaced"
  | "canceled";

export interface PartyRef {
  kind: ProfileKind;
  id: string;
}

export interface IssuedCardRecord {
  id: string;
  idempotencyKey: string;
  individualProfileId: string | null;
  organizationId: string | null;
  cardType: CardType;
  providerName: string;
  providerCardRef: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  expiresAtMonth: number | null;
  expiresAtYear: number | null;
  status: IssuedCardStatus;
  shippingAddress: Record<string, string> | null;
  activatedAt: Date | null;
  frozenAt: Date | null;
  frozenReason: string | null;
  closedAt: Date | null;
  closedReason: string | null;
  supersedesCardId: string | null;
  requestedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzleIssuedCardRepository. Append-only — every "mark*" method sets fields on an existing row; a replacement is always a new row (supersedesCardId), never a mutation of the card fields on the row it replaces. */
export interface IssuedCardRepository {
  insert(input: {
    idempotencyKey: string;
    individualProfileId: string | null;
    organizationId: string | null;
    cardType: CardType;
    providerName: string;
    shippingAddress: Record<string, string> | null;
    requestedByUserId: string;
    supersedesCardId: string | null;
  }): Promise<IssuedCardRecord>;
  findById(id: string): Promise<IssuedCardRecord | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<IssuedCardRecord | null>;
  findByProviderCardRef(providerCardRef: string): Promise<IssuedCardRecord | null>;
  listForParty(individualProfileId: string | null, organizationId: string | null): Promise<IssuedCardRecord[]>;
  markPendingIssuance(id: string): Promise<IssuedCardRecord>;
  markIssued(
    id: string,
    input: { providerCardRef: string; cardLast4: string; cardBrand: string | null; expiresAtMonth: number; expiresAtYear: number },
  ): Promise<IssuedCardRecord>;
  markRequestFailed(id: string): Promise<IssuedCardRecord>;
  markActivated(id: string, activatedAt: Date): Promise<IssuedCardRecord>;
  markFrozen(id: string, frozenAt: Date, reason: string | null): Promise<IssuedCardRecord>;
  markUnfrozen(id: string): Promise<IssuedCardRecord>;
  markLostOrStolen(id: string, status: "lost" | "stolen"): Promise<IssuedCardRecord>;
  markReplaced(id: string, supersededBy: string): Promise<IssuedCardRecord>;
  markCanceled(id: string, closedAt: Date, reason: string): Promise<IssuedCardRecord>;
}

const ACTIVE_CAPABILITY: Capability = "change_payout_configuration";

function isExpired(card: Pick<IssuedCardRecord, "expiresAtMonth" | "expiresAtYear">, now: Date): boolean {
  if (card.expiresAtMonth === null || card.expiresAtYear === null) return false;
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  if (currentYear !== card.expiresAtYear) return currentYear > card.expiresAtYear;
  return currentMonth > card.expiresAtMonth;
}

/**
 * PRSprint 24 (docs/prsprints/PRSPRINT_24_DEBIT_CARD_ISSUANCE_CARD_LIFECYCLE.md): PAY2PAY-issued
 * card lifecycle — request, activate, freeze/unfreeze, report lost/stolen, replace, cancel. Mirrors
 * `AchMandateService`/`DebitCardMethodService`'s established shape (party-authorized, append-only
 * history, audited every transition) and `PaymentService`'s idempotency-key pattern (insert-then-
 * recheck-on-conflict). Structurally incapable of touching the Phase 5 ledger or any agreement's
 * obligation — this class has no dependency on `LedgerService`/`BalanceService`/`AgreementService`,
 * matching the "Provider -> PAY2PAY source-of-truth rule": a card's own lifecycle is a fact about the
 * card-issuing provider's infrastructure, never PAY2PAY's payer-to-creditor domain state.
 *
 * Requires the cardholder to be fully identity-verified before a card can even be *requested* —
 * PRSprint 22's "unverified parties cannot receive live financial capability when verification is
 * required," applied here directly (issuing a spendable card to an unverified party is the actual
 * regulatory risk this PRSprint's KYC/KYB dependency exists to prevent).
 */
export class CardService {
  constructor(
    private readonly deps: {
      cards: IssuedCardRepository;
      provider: CardIssuingProvider;
      verification: VerificationService;
      profileOwners: ProfileOwnerReader;
      staffService: StaffService;
      audit: AuditService;
    },
  ) {}

  async requestCard(input: {
    idempotencyKey: string;
    cardholder: PartyRef;
    cardType: CardType;
    shippingAddress?: Record<string, string> | null;
    actingUserId: string;
  }): Promise<IssuedCardRecord> {
    const existing = await this.deps.cards.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    await this.authorizeParty(input.actingUserId, input.cardholder);
    const verified = await this.deps.verification.isFullyVerified(input.cardholder.kind, input.cardholder.id);
    if (!verified) {
      throw new ValidationError("The cardholder must complete identity verification before a card can be issued.");
    }
    if (input.cardType === "physical" && !input.shippingAddress) {
      throw new ValidationError("A shipping address is required to request a physical card.");
    }

    return this.createAndRequest({
      idempotencyKey: input.idempotencyKey,
      cardholder: input.cardholder,
      cardType: input.cardType,
      shippingAddress: input.shippingAddress ?? null,
      actingUserId: input.actingUserId,
      supersedesCardId: null,
    });
  }

  private async createAndRequest(input: {
    idempotencyKey: string;
    cardholder: PartyRef;
    cardType: CardType;
    shippingAddress: Record<string, string> | null;
    actingUserId: string;
    supersedesCardId: string | null;
  }): Promise<IssuedCardRecord> {
    let record: IssuedCardRecord;
    try {
      record = await this.deps.cards.insert({
        idempotencyKey: input.idempotencyKey,
        individualProfileId: input.cardholder.kind === "personal" ? input.cardholder.id : null,
        organizationId: input.cardholder.kind === "business" ? input.cardholder.id : null,
        cardType: input.cardType,
        providerName: this.deps.provider.providerName,
        shippingAddress: input.shippingAddress,
        requestedByUserId: input.actingUserId,
        supersedesCardId: input.supersedesCardId,
      });
    } catch (error) {
      const raced = await this.deps.cards.findByIdempotencyKey(input.idempotencyKey);
      if (raced) return raced;
      throw error;
    }
    await this.recordAudit(record, "card_requested", input.actingUserId, null);

    const pending = await this.deps.cards.markPendingIssuance(record.id);
    try {
      const result = await this.deps.provider.requestCard({
        cardholder: { profileKind: input.cardholder.kind, profileId: input.cardholder.id },
        cardType: input.cardType,
        shippingAddress: input.shippingAddress,
      });
      const issued = await this.deps.cards.markIssued(pending.id, result);
      await this.recordAudit(issued, "card_issued", input.actingUserId, null);
      return issued;
    } catch (error) {
      const failed = await this.deps.cards.markRequestFailed(pending.id);
      await this.recordAudit(failed, "card_issuance_failed", input.actingUserId, error instanceof Error ? error.message : "unknown_provider_error");
      throw new ValidationError("The card could not be issued by the provider.");
    }
  }

  async activateCard(cardId: string, actingUserId: string): Promise<IssuedCardRecord> {
    const record = await this.getAuthorizedRecord(cardId, actingUserId);
    if (record.status !== "issued") {
      throw new ValidationError(`Only a card in "issued" status can be activated (current status: "${record.status}").`);
    }
    if (!record.providerCardRef) throw new ValidationError("This card has no provider reference to activate.");
    const result = await this.deps.provider.activateCard(record.providerCardRef);
    if (!result.succeeded) throw new ValidationError("The provider did not permit activating this card.");
    const updated = await this.deps.cards.markActivated(record.id, new Date());
    await this.recordAudit(updated, "card_activated", actingUserId, null);
    return updated;
  }

  async freezeCard(cardId: string, actingUserId: string, reason: string | null): Promise<IssuedCardRecord> {
    const record = await this.getAuthorizedRecord(cardId, actingUserId);
    if (record.status === "frozen") return record; // idempotent
    if (record.status !== "active") {
      throw new ValidationError(`Only an active card can be frozen (current status: "${record.status}").`);
    }
    if (!record.providerCardRef) throw new ValidationError("This card has no provider reference to freeze.");
    const result = await this.deps.provider.freezeCard(record.providerCardRef);
    if (!result.succeeded) throw new ValidationError("The provider did not permit freezing this card.");
    const updated = await this.deps.cards.markFrozen(record.id, new Date(), reason);
    await this.recordAudit(updated, "card_frozen", actingUserId, reason);
    return updated;
  }

  async unfreezeCard(cardId: string, actingUserId: string): Promise<IssuedCardRecord> {
    const record = await this.getAuthorizedRecord(cardId, actingUserId);
    if (record.status === "active") return record; // idempotent
    if (record.status !== "frozen") {
      throw new ValidationError(`Only a frozen card can be unfrozen (current status: "${record.status}").`);
    }
    if (!record.providerCardRef) throw new ValidationError("This card has no provider reference to unfreeze.");
    const result = await this.deps.provider.unfreezeCard(record.providerCardRef);
    if (!result.succeeded) throw new ValidationError("The provider did not permit unfreezing this card.");
    const updated = await this.deps.cards.markUnfrozen(record.id);
    await this.recordAudit(updated, "card_unfrozen", actingUserId, null);
    return updated;
  }

  /**
   * Reports the card lost/stolen with the provider and immediately requests a replacement, linked
   * back via `supersedesCardId` — mirrors `DebitCardMethodService.replaceCard`'s identical
   * revoke-and-register-in-one-call precedent. Never mutates the old card's own fields beyond its
   * status/closedAt.
   */
  async reportLostOrStolen(cardId: string, actingUserId: string, reason: "lost" | "stolen"): Promise<{ oldCard: IssuedCardRecord; replacement: IssuedCardRecord }> {
    const record = await this.getAuthorizedRecord(cardId, actingUserId);
    if (record.status !== "active" && record.status !== "frozen" && record.status !== "issued") {
      throw new ValidationError(`Only an active, frozen, or issued card can be reported lost/stolen (current status: "${record.status}").`);
    }
    if (!record.providerCardRef) throw new ValidationError("This card has no provider reference to report.");
    await this.deps.provider.reportLostOrStolen(record.providerCardRef, reason);
    const closed = await this.deps.cards.markLostOrStolen(record.id, reason);
    await this.recordAudit(closed, reason === "lost" ? "card_reported_lost" : "card_reported_stolen", actingUserId, null);

    const cardholder: PartyRef = closed.individualProfileId
      ? { kind: "personal", id: closed.individualProfileId }
      : { kind: "business", id: closed.organizationId! };
    const replacement = await this.createAndRequest({
      idempotencyKey: `card-replacement-${closed.id}`,
      cardholder,
      cardType: closed.cardType,
      shippingAddress: closed.shippingAddress,
      actingUserId,
      supersedesCardId: closed.id,
    });
    const superseded = await this.deps.cards.markReplaced(closed.id, replacement.id);
    return { oldCard: superseded, replacement };
  }

  async cancelCard(cardId: string, actingUserId: string, reason: string): Promise<IssuedCardRecord> {
    if (!reason.trim()) throw new ValidationError("A reason is required to cancel a card.");
    const record = await this.getAuthorizedRecord(cardId, actingUserId);
    if (record.status === "canceled") return record; // idempotent
    if (["replaced", "lost", "stolen"].includes(record.status)) {
      throw new ValidationError(`A card in "${record.status}" status cannot be canceled directly.`);
    }
    if (record.providerCardRef) {
      const result = await this.deps.provider.cancelCard(record.providerCardRef);
      if (!result.succeeded) throw new ValidationError("The provider did not permit cancelling this card.");
    }
    const updated = await this.deps.cards.markCanceled(record.id, new Date(), reason);
    await this.recordAudit(updated, "card_canceled", actingUserId, reason);
    return updated;
  }

  async listCardsForParty(actingUserId: string, party: PartyRef): Promise<IssuedCardRecord[]> {
    await this.authorizeParty(actingUserId, party);
    return this.deps.cards.listForParty(party.kind === "personal" ? party.id : null, party.kind === "business" ? party.id : null);
  }

  async getCard(cardId: string, actingUserId: string): Promise<IssuedCardRecord> {
    return this.getAuthorizedRecord(cardId, actingUserId);
  }

  isCardExpired(card: Pick<IssuedCardRecord, "expiresAtMonth" | "expiresAtYear">, now: Date = new Date()): boolean {
    return isExpired(card, now);
  }

  private async getAuthorizedRecord(cardId: string, actingUserId: string): Promise<IssuedCardRecord> {
    const record = await this.deps.cards.findById(cardId);
    if (!record) throw new ValidationError("Card not found.");
    const party: PartyRef = record.individualProfileId
      ? { kind: "personal", id: record.individualProfileId }
      : { kind: "business", id: record.organizationId! };
    await this.authorizeParty(actingUserId, party);
    return record;
  }

  private async authorizeParty(actingUserId: string, party: PartyRef): Promise<void> {
    if (party.kind === "personal") {
      const ownerUserId = await this.deps.profileOwners.getOwnerUserId("personal", party.id);
      if (ownerUserId !== actingUserId) {
        throw new ForbiddenError("You do not have access to this profile's cards.");
      }
      return;
    }
    const ownerUserId = await this.deps.profileOwners.getOwnerUserId("business", party.id);
    if (ownerUserId === actingUserId) return;
    await this.deps.staffService.requireCapability(party.id, actingUserId, ACTIVE_CAPABILITY);
  }

  private async recordAudit(card: IssuedCardRecord, action: string, actorUserId: string, reason: string | null): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "agreement_party",
      profileKind: card.individualProfileId ? "personal" : "business",
      profileId: card.individualProfileId ?? card.organizationId,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue: card.status,
      reason,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      targetResourceType: "issued_card",
      targetResourceId: card.id,
    });
  }
}

