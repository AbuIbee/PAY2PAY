import "server-only";
import type { ProfileRef } from "@/lib/payments/paymentProvider";

export type CardType = "virtual" | "physical";

export interface RequestCardInput {
  cardholder: ProfileRef;
  cardType: CardType;
  /** Only meaningful/required for a physical card. */
  shippingAddress?: Record<string, string> | null;
}

export interface RequestCardResult {
  providerCardRef: string;
  cardLast4: string;
  cardBrand: string | null;
  expiresAtMonth: number;
  expiresAtYear: number;
}

export interface CardActionResult {
  succeeded: boolean;
}

export interface ParsedCardWebhookEvent {
  provider: string;
  providerEventId: string;
  eventType: string;
  data: Record<string, unknown>;
}

/**
 * PRSprint 24 (docs/prsprints/PRSPRINT_24_DEBIT_CARD_ISSUANCE_CARD_LIFECYCLE.md) provider-independent
 * card-issuing abstraction — mirrors `PaymentProvider`/`KycKybProvider`'s established shape exactly
 * (Sprint 9's "do not merge the two interfaces" precedent extended to this third, distinct provider
 * concern). `CardService` depends only on this interface, never a specific issuing processor's SDK.
 * Every method that could touch cardholder data returns/accepts only non-sensitive display metadata
 * (last4/brand/expiry) or an opaque `providerCardRef` — never a PAN, CVV, or PIN (this PRSprint's own
 * Hard Stop).
 */
export interface CardIssuingProvider {
  readonly providerName: string;
  readonly providerEnvironment: "sandbox" | "production";
  requestCard(input: RequestCardInput): Promise<RequestCardResult>;
  activateCard(providerCardRef: string): Promise<CardActionResult>;
  freezeCard(providerCardRef: string): Promise<CardActionResult>;
  unfreezeCard(providerCardRef: string): Promise<CardActionResult>;
  reportLostOrStolen(providerCardRef: string, reason: "lost" | "stolen"): Promise<CardActionResult>;
  cancelCard(providerCardRef: string): Promise<CardActionResult>;
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean;
  parseWebhookEvent(rawBody: string): ParsedCardWebhookEvent;
}
