import "server-only";
import { DrizzlePricingPlanRepository } from "./drizzlePricingPlanRepository";
import { DrizzleSubscriptionRepository } from "./drizzleSubscriptionRepository";
import { PricingService } from "./pricingService";

let cached: PricingService | null = null;

export function getPricingService(): PricingService {
  if (!cached) {
    cached = new PricingService(new DrizzlePricingPlanRepository(), new DrizzleSubscriptionRepository());
  }
  return cached;
}
