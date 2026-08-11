import "server-only";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import { DrizzleKycWebhookEventRepository } from "./drizzleKycWebhookEventRepository";
import { getKycProvider } from "./getKycProvider";
import { KycWebhookService } from "./kycWebhookService";

let cached: KycWebhookService | null = null;

export function getKycWebhookService(): KycWebhookService {
  if (!cached) {
    cached = new KycWebhookService({
      provider: getKycProvider(),
      events: new DrizzleKycWebhookEventRepository(),
      verification: getVerificationService(),
    });
  }
  return cached;
}
