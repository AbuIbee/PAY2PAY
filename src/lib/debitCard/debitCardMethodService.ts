import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { ProfileRef } from "@/lib/payments/paymentProvider";

export type DebitCardMethodStatus = "active" | "replaced" | "expired";

export interface DebitCardMethodRecord {
  id: string;
  agreementId: string;
  payerProfileKind: ProfileKind;
  payerProfileId: string;
  cardToken: string;
  cardLast4: string;
  cardBrand: string | null;
  expiresAtMonth: number;
  expiresAtYear: number;
  status: DebitCardMethodStatus;
  registeredAt: Date;
  replacedAt: Date | null;
  replacedReason: string | null;
  supersedesCardMethodId: string | null;
  createdAt: Date;
}

/** Sprint 12 (docs/sprints/SPRINT_12_DebitCard_Sandbox.md): append-only, mirroring src/lib/ach/achMandateService.ts's AchMandateRepository — `insert` creates a new row, `markReplaced` only ever sets the replacement fields on an existing row, never deletes or overwrites its card fields. */
export interface DebitCardMethodRepository {
  insert(input: {
    agreementId: string;
    payerProfileKind: ProfileKind;
    payerProfileId: string;
    cardToken: string;
    cardLast4: string;
    cardBrand: string | null;
    expiresAtMonth: number;
    expiresAtYear: number;
    supersedesCardMethodId: string | null;
  }): Promise<DebitCardMethodRecord>;
  findActiveForAgreement(agreementId: string): Promise<DebitCardMethodRecord | null>;
  findById(id: string): Promise<DebitCardMethodRecord | null>;
  markReplaced(id: string, replacedAt: Date, replacedReason: string): Promise<DebitCardMethodRecord>;
}

function isExpired(card: Pick<DebitCardMethodRecord, "expiresAtMonth" | "expiresAtYear">, now: Date): boolean {
  // A card is valid through the LAST day of its expiry month — expired only once the calendar
  // month/year strictly after that has begun (matches how card networks treat expiry).
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1; // 1-12
  if (currentYear !== card.expiresAtYear) return currentYear > card.expiresAtYear;
  return currentMonth > card.expiresAtMonth;
}

/**
 * Sprint 12's card-on-file lifecycle, mirroring AchMandateService's shape and the same "structurally
 * incapable of touching ledger/balance/agreement data" guarantee — this class depends only on its
 * own repository, ProfileOwnerReader, and AuditService, so it has no path to affect the debt itself;
 * enforcement that an expired or replaced card blocks *new* charges lives in DebitCardPaymentService
 * (which reads card state before scheduling), not here.
 */
export class DebitCardMethodService {
  constructor(
    private readonly deps: {
      cards: DebitCardMethodRepository;
      profileOwners: ProfileOwnerReader;
      audit: AuditService;
    },
  ) {}

  async registerCard(input: {
    agreementId: string;
    payer: ProfileRef;
    cardToken: string;
    cardLast4: string;
    cardBrand: string | null;
    expiresAtMonth: number;
    expiresAtYear: number;
    actingUserId: string;
  }): Promise<DebitCardMethodRecord> {
    await this.requireOwner(input.payer, input.actingUserId, "register a card");
    this.requireValidExpiry(input.expiresAtMonth, input.expiresAtYear);
    const existing = await this.deps.cards.findActiveForAgreement(input.agreementId);
    if (existing) {
      throw new ConflictError("An active card is already on file for this agreement — use replaceCard instead.");
    }
    const record = await this.deps.cards.insert({
      agreementId: input.agreementId,
      payerProfileKind: input.payer.profileKind,
      payerProfileId: input.payer.profileId,
      cardToken: input.cardToken,
      cardLast4: input.cardLast4,
      cardBrand: input.cardBrand,
      expiresAtMonth: input.expiresAtMonth,
      expiresAtYear: input.expiresAtYear,
      supersedesCardMethodId: null,
    });
    await this.recordAudit(record, "debit_card_method_registered", input.actingUserId, null);
    return record;
  }

  /**
   * "Replaced card" (this sprint's required test category) — revokes the current active card (if
   * any) and registers a new one, linked back via `supersedesCardMethodId`, never mutating the old
   * card's fields in place. Distinct from `registerCard` only in requiring an explicit reason and an
   * existing card to replace, matching AchMandateService.handleBankChange's precedent.
   */
  async replaceCard(input: {
    agreementId: string;
    payer: ProfileRef;
    newCardToken: string;
    cardLast4: string;
    cardBrand: string | null;
    expiresAtMonth: number;
    expiresAtYear: number;
    reason: string;
    actingUserId: string;
  }): Promise<DebitCardMethodRecord> {
    await this.requireOwner(input.payer, input.actingUserId, "replace this card");
    this.requireValidExpiry(input.expiresAtMonth, input.expiresAtYear);
    const existing = await this.deps.cards.findActiveForAgreement(input.agreementId);
    if (!existing) {
      throw new ValidationError("There is no active card on file to replace.");
    }
    await this.deps.cards.markReplaced(existing.id, new Date(), input.reason);
    await this.recordAudit(existing, "debit_card_method_superseded", input.actingUserId, input.reason);

    const record = await this.deps.cards.insert({
      agreementId: input.agreementId,
      payerProfileKind: input.payer.profileKind,
      payerProfileId: input.payer.profileId,
      cardToken: input.newCardToken,
      cardLast4: input.cardLast4,
      cardBrand: input.cardBrand,
      expiresAtMonth: input.expiresAtMonth,
      expiresAtYear: input.expiresAtYear,
      supersedesCardMethodId: existing.id,
    });
    await this.recordAudit(record, "debit_card_method_registered", input.actingUserId, "Replaced an expiring or compromised card.");
    return record;
  }

  async getActiveCard(agreementId: string): Promise<DebitCardMethodRecord | null> {
    return this.deps.cards.findActiveForAgreement(agreementId);
  }

  /** Lazy, read-time expiry check (see this file's module-level isExpired) — never a stored transition; mirrors ach_mandate_status's "expired reserved, never set directly" precedent (src/db/schema/enums.ts). */
  isCardExpired(card: Pick<DebitCardMethodRecord, "expiresAtMonth" | "expiresAtYear">, now: Date = new Date()): boolean {
    return isExpired(card, now);
  }

  private requireValidExpiry(month: number, year: number): void {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new ValidationError("expiresAtMonth must be an integer between 1 and 12.");
    }
    if (!Number.isInteger(year) || year < 2000) {
      throw new ValidationError("expiresAtYear must be a valid 4-digit year.");
    }
    if (isExpired({ expiresAtMonth: month, expiresAtYear: year }, new Date())) {
      throw new ValidationError("This card has already expired — it cannot be registered.");
    }
  }

  private async requireOwner(profile: ProfileRef, actingUserId: string, action: string): Promise<void> {
    const ownerUserId = await this.deps.profileOwners.getOwnerUserId(profile.profileKind, profile.profileId);
    if (ownerUserId !== actingUserId) {
      throw new ForbiddenError(`You may only ${action} for your own profile.`);
    }
  }

  private async recordAudit(
    card: DebitCardMethodRecord,
    action: string,
    actorUserId: string,
    reason: string | null,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: "personal_user",
      profileKind: card.payerProfileKind,
      profileId: card.payerProfileId,
      agreementId: card.agreementId,
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
      targetResourceType: "debit_card_method",
      targetResourceId: card.id,
    });
  }
}
