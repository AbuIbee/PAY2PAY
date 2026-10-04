import "server-only";
import { BusinessVerificationWebhookService } from "./businessVerificationWebhookService";
import { DrizzleBusinessVerificationWebhookEventRepository } from "./drizzleBusinessVerificationWebhookEventRepository";
import { getBusinessVerificationProvider } from "./getBusinessVerificationProvider";
import { getBusinessVerificationService } from "./getBusinessVerificationService";

let cached: BusinessVerificationWebhookService | null = null;

/** Mirrors getKycWebhookService.ts's identical "construct lazily, fail closed at the point of use" pattern — see that file's own doc comment. */
export function getBusinessVerificationWebhookService(): BusinessVerificationWebhookService {
  if (!cached) {
    cached = new BusinessVerificationWebhookService({
      provider: getBusinessVerificationProvider(),
      events: new DrizzleBusinessVerificationWebhookEventRepository(),
      verification: getBusinessVerificationService(),
    });
  }
  return cached;
}
