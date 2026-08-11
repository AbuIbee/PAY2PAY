import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { SandboxKycProvider } from "./sandboxKycProvider";
import type { KycKybProvider } from "./kycProvider";

let cached: SandboxKycProvider | null = null;

/** Sprint 9: the only KycKybProvider wired up in this codebase — sandbox only, per "sandbox/test mode only." */
export function getKycProvider(): KycKybProvider {
  if (!cached) {
    const { KYC_SANDBOX_WEBHOOK_SECRET } = getServerEnv();
    if (!KYC_SANDBOX_WEBHOOK_SECRET) {
      throw new ConfigurationError("KYC_SANDBOX_WEBHOOK_SECRET is not configured.");
    }
    cached = new SandboxKycProvider(KYC_SANDBOX_WEBHOOK_SECRET);
  }
  return cached;
}
