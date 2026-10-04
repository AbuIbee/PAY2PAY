import "server-only";
import { getLegalAcceptanceService } from "@/lib/legal/getLegalAcceptanceService";
import { DrizzleSubscriptionRepository } from "@/lib/pricing/drizzleSubscriptionRepository";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import { BusinessActivationService } from "./businessActivationService";
import { DrizzleBusinessVerificationRepository } from "./drizzleBusinessVerificationRepository";

let cached: BusinessActivationService | null = null;

export function getBusinessActivationService(): BusinessActivationService {
  if (!cached) {
    cached = new BusinessActivationService(
      new DrizzleBusinessProfileRepository(),
      new DrizzleBusinessVerificationRepository(),
      new DrizzleSubscriptionRepository(),
      getLegalAcceptanceService(),
    );
  }
  return cached;
}
