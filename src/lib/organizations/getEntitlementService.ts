import "server-only";
import { DrizzlePricingPlanEntitlementRepository } from "@/lib/pricing/drizzlePricingPlanEntitlementRepository";
import { getPricingService } from "@/lib/pricing/getPricingService";
import { EntitlementService } from "./entitlementService";

let cached: EntitlementService | null = null;

export function getEntitlementService(): EntitlementService {
  if (!cached) {
    cached = new EntitlementService(getPricingService(), new DrizzlePricingPlanEntitlementRepository());
  }
  return cached;
}
