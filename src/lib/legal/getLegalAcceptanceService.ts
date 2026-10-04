import "server-only";
import { DrizzleLegalAcceptanceRepository } from "./drizzleLegalAcceptanceRepository";
import { LegalAcceptanceService } from "./legalAcceptanceService";

let cached: LegalAcceptanceService | null = null;

export function getLegalAcceptanceService(): LegalAcceptanceService {
  if (!cached) {
    cached = new LegalAcceptanceService(new DrizzleLegalAcceptanceRepository());
  }
  return cached;
}
