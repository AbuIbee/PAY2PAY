import "server-only";
import { DrizzleConsentRepository } from "./drizzleConsentRepository";
import { ConsentService } from "./consentService";

let cached: ConsentService | null = null;

export function getConsentService(): ConsentService {
  if (!cached) {
    cached = new ConsentService({ consents: new DrizzleConsentRepository() });
  }
  return cached;
}
