import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import { ValidationError } from "@/lib/errors";
import { computeHmacSignature, verifyHmacSignature } from "@/lib/webhookSignature";
import type {
  CardActionResult,
  CardIssuingProvider,
  ParsedCardWebhookEvent,
  RequestCardInput,
  RequestCardResult,
} from "./cardIssuingProvider";

interface StoredSandboxCard {
  status: "active" | "frozen" | "canceled" | "lost" | "stolen";
  last4: string;
}

/**
 * PRSprint 24's sandbox/mock card-issuing provider — NOT a real Marqeta/Stripe Issuing sandbox
 * integration (this environment has no live provider credentials). Every operation is a
 * deterministic, purely local simulation; nothing here ever reaches a real network, produces a real
 * spendable card, or moves real money. Mirrors `SandboxPaymentProvider`/`SandboxKycProvider`'s
 * identical "the one piece of real behavior is the webhook HMAC signing/verification" precedent.
 */
export class SandboxCardIssuingProvider implements CardIssuingProvider {
  readonly providerName = "sandbox_card_issuing_mock";
  readonly providerEnvironment = "sandbox" as const;
  private readonly cards = new Map<string, StoredSandboxCard>();

  constructor(private readonly webhookSecret: string) {}

  async requestCard(input: RequestCardInput): Promise<RequestCardResult> {
    if (input.cardType === "physical" && !input.shippingAddress) {
      throw new ValidationError("A shipping address is required to request a physical card.");
    }
    const providerCardRef = `sandbox_card_${randomUUID()}`;
    const last4 = String(randomInt(0, 10_000)).padStart(4, "0");
    this.cards.set(providerCardRef, { status: "active", last4 });
    const now = new Date();
    return {
      providerCardRef,
      cardLast4: last4,
      cardBrand: "sandbox_visa",
      expiresAtMonth: now.getUTCMonth() + 1,
      expiresAtYear: now.getUTCFullYear() + 4,
    };
  }

  async activateCard(providerCardRef: string): Promise<CardActionResult> {
    const card = this.requireCard(providerCardRef);
    if (card.status !== "active") return { succeeded: false };
    return { succeeded: true };
  }

  async freezeCard(providerCardRef: string): Promise<CardActionResult> {
    const card = this.requireCard(providerCardRef);
    if (card.status !== "active" && card.status !== "frozen") return { succeeded: false };
    card.status = "frozen";
    return { succeeded: true };
  }

  async unfreezeCard(providerCardRef: string): Promise<CardActionResult> {
    const card = this.requireCard(providerCardRef);
    if (card.status !== "frozen" && card.status !== "active") return { succeeded: false };
    card.status = "active";
    return { succeeded: true };
  }

  async reportLostOrStolen(providerCardRef: string, reason: "lost" | "stolen"): Promise<CardActionResult> {
    const card = this.requireCard(providerCardRef);
    card.status = reason;
    return { succeeded: true };
  }

  async cancelCard(providerCardRef: string): Promise<CardActionResult> {
    const card = this.requireCard(providerCardRef);
    card.status = "canceled";
    return { succeeded: true };
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    return verifyHmacSignature(rawBody, signatureHeader, this.webhookSecret);
  }

  parseWebhookEvent(rawBody: string): ParsedCardWebhookEvent {
    let parsed: { providerEventId?: unknown; eventType?: unknown; [key: string]: unknown };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      throw new ValidationError("Webhook payload is not valid JSON.");
    }
    if (typeof parsed.providerEventId !== "string" || typeof parsed.eventType !== "string") {
      throw new ValidationError("Webhook payload is missing providerEventId/eventType.");
    }
    return {
      provider: this.providerName,
      providerEventId: parsed.providerEventId,
      eventType: parsed.eventType,
      data: parsed,
    };
  }

  /** Test/sandbox-simulator helper — produces a signature a real caller would send in the webhook's signature header. */
  signWebhookPayload(rawBody: string): string {
    return computeHmacSignature(rawBody, this.webhookSecret);
  }

  private requireCard(providerCardRef: string): StoredSandboxCard {
    const card = this.cards.get(providerCardRef);
    if (!card) throw new ValidationError("Unknown card reference.");
    return card;
  }
}
