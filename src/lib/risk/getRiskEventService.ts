import "server-only";
import { getAdminRoleService } from "@/lib/admin/getAdminRoleService";
import { DrizzleRiskEventRepository } from "./drizzleRiskEventRepository";
import { RiskEventService } from "./riskEventService";

let cached: RiskEventService | null = null;

export function getRiskEventService(): RiskEventService {
  if (!cached) {
    cached = new RiskEventService({ riskEvents: new DrizzleRiskEventRepository(), roles: getAdminRoleService() });
  }
  return cached;
}
