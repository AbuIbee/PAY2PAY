import "server-only";
import type { VerificationService } from "@/lib/profiles/verificationService";
import type {
  KycKybProvider,
  SubmitBusinessVerificationInput,
  SubmitIndividualVerificationInput,
  SubmitVerificationResult,
} from "./kycProvider";

/**
 * Sprint 9: the "submit" half of the KYC/KYB integration. Reuses Sprint 3's
 * `submitFullVerificationRequest` for the pending-record creation (and, unchanged, its existing
 * "already pending" ConflictError — this IS the "duplicate verification submission" guard, not a
 * new one built here) before ever calling the provider, then attaches the provider's own
 * verification id via `recordProviderSubmission` so a later webhook can resolve back to this
 * profile. If the provider call itself fails after the pending record is created, the profile is
 * left at FULL_PENDING with no `providerRef` — a known Sprint 9 limitation (no automated
 * resubmission/cleanup job exists yet); a manual resubmission or an administrator decision resolves
 * it, same as any other stuck-pending case.
 */
export class KycVerificationService {
  constructor(
    private readonly deps: {
      provider: KycKybProvider;
      verification: VerificationService;
    },
  ) {}

  async submitIndividualVerification(input: SubmitIndividualVerificationInput): Promise<SubmitVerificationResult> {
    await this.deps.verification.submitFullVerificationRequest("personal", input.profileId);
    const result = await this.deps.provider.submitIndividualVerification(input);
    await this.deps.verification.recordProviderSubmission("personal", input.profileId, result.providerVerificationId);
    return result;
  }

  async submitBusinessVerification(input: SubmitBusinessVerificationInput): Promise<SubmitVerificationResult> {
    await this.deps.verification.submitFullVerificationRequest("business", input.profileId);
    const result = await this.deps.provider.submitBusinessVerification(input);
    await this.deps.verification.recordProviderSubmission("business", input.profileId, result.providerVerificationId);
    return result;
  }
}
