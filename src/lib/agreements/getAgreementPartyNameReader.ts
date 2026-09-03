import "server-only";
import { getPersonalProfileService } from "@/lib/profiles/getPersonalProfileService";
import type { AgreementPartyNameReader } from "./agreementService";

let cached: AgreementPartyNameReader | null = null;

/**
 * Production defect remediation (agreement participation requires a usable name): thin, memoized
 * adapter over the existing, previously-unwired PersonalProfileService.checkAgreementParticipationReadiness
 * (that method's own doc comment already named this exact purpose — "before a personal user can
 * complete their agreement participation... require... First name, Last name" — it was simply never
 * called anywhere but the client-side profile-completeness hint). Reuses its firstName/lastName-missing
 * detection verbatim rather than a second, divergent completeness check; deliberately ignores that
 * same result's phone/preferredEmail/address fields — those remain the existing, separate,
 * unrelated profile-completeness UX (`ProfileCompletionPanel`) this fix does not touch or require.
 */
export function getAgreementPartyNameReader(): AgreementPartyNameReader {
  if (!cached) {
    const personalProfileService = getPersonalProfileService();
    cached = {
      async hasRequiredName(actingUserId: string): Promise<boolean> {
        const { missingFields } = await personalProfileService.checkAgreementParticipationReadiness(actingUserId);
        return !missingFields.includes("firstName") && !missingFields.includes("lastName");
      },
    };
  }
  return cached;
}
