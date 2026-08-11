import "server-only";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import { getKycProvider } from "./getKycProvider";
import { KycVerificationService } from "./kycVerificationService";

let cached: KycVerificationService | null = null;

export function getKycVerificationService(): KycVerificationService {
  if (!cached) {
    cached = new KycVerificationService({
      provider: getKycProvider(),
      verification: getVerificationService(),
    });
  }
  return cached;
}
