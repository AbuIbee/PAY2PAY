import { describe, expect, it } from "vitest";
import { ConfigurationError } from "@/lib/errors";
import {
  assertProviderEnvironmentConsistency,
  getProviderCapabilityDescriptor,
  PROVIDER_CAPABILITY_REGISTRY,
  providerSupportsCapability,
} from "./providerCapabilities";

describe(
  "providerCapabilities (PRSprint 21 — docs/prsprints/PRSPRINT_21_PRODUCTION_FINANCIAL_PROVIDER_ARCHITECTURE.md)",
  () => {
    it("resolves a registered provider's capability descriptor", () => {
      const descriptor = getProviderCapabilityDescriptor("sandbox_mock");
      expect(descriptor.environment).toBe("sandbox");
      expect(descriptor.capabilities).toContain("ach_debit");
    });

    it("throws a clear ConfigurationError for an unregistered provider name — never silently returns undefined capabilities", () => {
      expect(() => getProviderCapabilityDescriptor("some_future_provider")).toThrow(ConfigurationError);
    });

    it("providerSupportsCapability correctly distinguishes capabilities a provider does and does not declare", () => {
      const descriptor = getProviderCapabilityDescriptor("sandbox_kyc_mock");
      expect(providerSupportsCapability(descriptor, "kyc")).toBe(true);
      expect(providerSupportsCapability(descriptor, "kyb")).toBe(true);
      // The KYC sandbox has no debit-card-issuing capability — must not be assumed present.
      expect(providerSupportsCapability(descriptor, "debit_card_issuing")).toBe(false);
    });

    it("permits a sandbox provider in every environment, including production (today's actual, correct state)", () => {
      const descriptor = getProviderCapabilityDescriptor("sandbox_mock");
      for (const appEnv of ["development", "test", "staging", "production"]) {
        expect(() => assertProviderEnvironmentConsistency(descriptor, appEnv)).not.toThrow();
      }
    });

    it("rejects a production-tagged provider constructed outside a genuine production environment", () => {
      const liveDescriptor = { providerName: "future_live_provider", environment: "production" as const, capabilities: [] };
      expect(() => assertProviderEnvironmentConsistency(liveDescriptor, "development")).toThrow(ConfigurationError);
      expect(() => assertProviderEnvironmentConsistency(liveDescriptor, "staging")).toThrow(ConfigurationError);
      expect(() => assertProviderEnvironmentConsistency(liveDescriptor, "production")).not.toThrow();
    });

    it("every registered provider's descriptor.providerName matches its own registry key — the registry can never resolve a provider under the wrong name", () => {
      for (const [key, descriptor] of Object.entries(PROVIDER_CAPABILITY_REGISTRY)) {
        expect(descriptor.providerName).toBe(key);
      }
    });
  },
);
