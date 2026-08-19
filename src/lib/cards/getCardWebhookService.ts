import "server-only";
import { CardWebhookService } from "./cardWebhookService";
import { DrizzleCardTransactionEventRepository, DrizzleIssuedCardRefResolver } from "./drizzleCardTransactionEventRepository";
import { getCardIssuingProvider } from "./getCardIssuingProvider";

let cached: CardWebhookService | null = null;

export function getCardWebhookService(): CardWebhookService {
  if (!cached) {
    cached = new CardWebhookService({
      provider: getCardIssuingProvider(),
      events: new DrizzleCardTransactionEventRepository(),
      cards: new DrizzleIssuedCardRefResolver(),
    });
  }
  return cached;
}
