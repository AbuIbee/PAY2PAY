import "server-only";
import { DrizzlePricingPlanEntitlementRepository } from "@/lib/pricing/drizzlePricingPlanEntitlementRepository";
import { getPricingService } from "@/lib/pricing/getPricingService";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import { EntitlementService } from "./entitlementService";

let cached: EntitlementService | null = null;

export function getEntitlementService(): EntitlementService {
  if (!cached) {
    cached = new EntitlementService(getPricingService(), new DrizzlePricingPlanEntitlementRepository(), new DrizzleBusinessProfileRepository());
  }
  return cached;
}
