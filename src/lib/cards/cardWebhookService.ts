import "server-only";
import { ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { CardIssuingProvider } from "./cardIssuingProvider";

export type CardTransactionEventType = "authorization" | "clearing" | "settlement" | "decline" | "reversal";

export interface CardTransactionEventRecord {
  id: string;
  issuedCardId: string;
  provider: string;
  providerEventId: string;
  eventType: CardTransactionEventType;
  providerTransactionRef: string;
  amountMinorUnits: number;
  currency: string;
  merchantDisplayName: string | null;
  signatureVerified: boolean;
  payload: unknown;
  receivedAt: Date;
  processedAt: Date | null;
}

/** Append-only — mirrors PaymentWebhookEventRepository/KycWebhookEventRepository's identical shape; no update/delete method exists anywhere on this interface. */
export interface CardTransactionEventRepository {
  findByProviderEvent(provider: string, providerEventId: string): Promise<CardTransactionEventRecord | null>;
  insert(input: {
    issuedCardId: string;
    provider: string;
    providerEventId: string;
    eventType: CardTransactionEventType;
    providerTransactionRef: string;
    amountMinorUnits: number;
    currency: string;
    merchantDisplayName: string | null;
    signatureVerified: boolean;
    payload: unknown;
  }): Promise<CardTransactionEventRecord>;
  markProcessed(id: string): Promise<void>;
  listForCard(issuedCardId: string): Promise<CardTransactionEventRecord[]>;
}

/** Narrow reader — this webhook only ever needs to resolve a providerCardRef back to the issued_card row it belongs to; never writes to issued_card itself. */
export interface IssuedCardRefResolver {
  findIdByProviderCardRef(providerCardRef: string): Promise<string | null>;
}

export type ReceiveCardWebhookResult = { status: "processed" | "duplicate" | "unknown_card" };

/**
 * PRSprint 24 (docs/prsprints/PRSPRINT_24_DEBIT_CARD_ISSUANCE_CARD_LIFECYCLE.md): the card-transaction
 * webhook counterpart to `PaymentWebhookService`/`KycWebhookService` — identical signature-
 * verification -> replay/duplicate-event protection -> idempotent-processing shape (including Phase 5
 * PRSprint 20's insert-then-recheck-on-conflict race hardening), applied here to authorization/
 * clearing/settlement/decline/reversal events instead of payment-status or KYC-decision transitions.
 * Deliberately never posts a Phase 5 ledger entry and never mutates `issued_card.status` — a card
 * *transaction* is a spend event, not a card-lifecycle transition (those go through `CardService`
 * only) or a PAY2PAY obligation (see cardIssuing.ts's own doc comment for the full rationale).
 */
export class CardWebhookService {
  constructor(
    private readonly deps: {
      provider: CardIssuingProvider;
      events: CardTransactionEventRepository;
      cards: IssuedCardRefResolver;
    },
  ) {}

  async receiveWebhook(input: { rawBody: string; signatureHeader: string }): Promise<ReceiveCardWebhookResult> {
    const signatureValid = this.deps.provider.verifyWebhookSignature(input.rawBody, input.signatureHeader);
    if (!signatureValid) {
      throw new ForbiddenError("Webhook signature verification failed.");
    }

    const parsed = this.deps.provider.parseWebhookEvent(input.rawBody);

    const existing = await this.deps.events.findByProviderEvent(parsed.provider, parsed.providerEventId);
    if (existing) {
      return { status: "duplicate" };
    }

    const providerCardRef = typeof parsed.data.providerCardRef === "string" ? parsed.data.providerCardRef : null;
    const issuedCardId = providerCardRef ? await this.deps.cards.findIdByProviderCardRef(providerCardRef) : null;
    if (!issuedCardId) {
      // An event for a card reference this instance doesn't recognize — logged, not silently
      // dropped, but a redelivery of an event for an unrelated/unknown card must not fail the
      // provider's retry loop (mirrors PaymentWebhookService's identical "unmapped event" contract).
      logger.error("card_webhook_unknown_card", { providerEventId: parsed.providerEventId, providerCardRef });
      return { status: "unknown_card" };
    }

    const eventType = this.mapEventType(parsed.eventType);
    if (!eventType) {
      return { status: "unknown_card" };
    }
    const amountMinorUnits = typeof parsed.data.amountMinorUnits === "number" ? parsed.data.amountMinorUnits : 0;
    const currency = typeof parsed.data.currency === "string" ? parsed.data.currency : "USD";
    const providerTransactionRef = typeof parsed.data.providerTransactionRef === "string" ? parsed.data.providerTransactionRef : parsed.providerEventId;
    const merchantDisplayName = typeof parsed.data.merchantDisplayName === "string" ? parsed.data.merchantDisplayName : null;

    // PRSprint 20-style insert-then-recheck-on-conflict — a genuinely concurrent redelivery can pass
    // the check above before either caller has inserted; the real DB's provider-event unique index
    // is what actually decides a winner.
    let eventRecord;
    try {
      eventRecord = await this.deps.events.insert({
        issuedCardId,
        provider: parsed.provider,
        providerEventId: parsed.providerEventId,
        eventType,
        providerTransactionRef,
        amountMinorUnits,
        currency,
        merchantDisplayName,
        signatureVerified: true,
        payload: parsed.data,
      });
    } catch (error) {
      const raced = await this.deps.events.findByProviderEvent(parsed.provider, parsed.providerEventId);
      if (raced) return { status: "duplicate" };
      throw error;
    }

    await this.deps.events.markProcessed(eventRecord.id);
    return { status: "processed" };
  }

  private mapEventType(rawEventType: string): CardTransactionEventType | null {
    const mapping: Record<string, CardTransactionEventType> = {
      "card_transaction.authorization": "authorization",
      "card_transaction.clearing": "clearing",
      "card_transaction.settlement": "settlement",
      "card_transaction.decline": "decline",
      "card_transaction.reversal": "reversal",
    };
    return mapping[rawEventType] ?? null;
  }
}
