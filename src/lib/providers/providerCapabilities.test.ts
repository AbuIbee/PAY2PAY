import { describe, expect, it } from "vitest";
import { ConfigurationError, ProviderNotAvailableError } from "@/lib/errors";
import {
  assertProviderAvailableForRuntime,
  findProviderCapabilityDescriptor,
  PROVIDER_CAPABILITY_REGISTRY,
  providerSupportsCapability,
} from "./providerCapabilities";

describe("providerCapabilities (PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION)", () => {
  it("PAID2YOU — B0-D ADYEN PHASE 1: the registry contains exactly one entry, 'adyen' — no sandbox/mock provider is registered, and none may be added here", () => {
    expect(Object.keys(PROVIDER_CAPABILITY_REGISTRY)).toEqual(["adyen"]);
    expect(PROVIDER_CAPABILITY_REGISTRY.adyen).toMatchObject({ providerName: "adyen", environment: "production" });
  });

  it("PAID2YOU — B0-D ADYEN PHASE 2: adyen's declared capabilities are exactly what AdyenPaymentProvider implements — ach_debit + webhook_delivery + bank_linking, nothing payout/KYC/card-issuing-related yet", () => {
    expect(PROVIDER_CAPABILITY_REGISTRY.adyen!.capabilities).toEqual(["ach_debit", "webhook_delivery", "bank_linking"]);
  });

  it("findProviderCapabilityDescriptor returns null for any unregistered name, including undefined and every retired sandbox name", () => {
    expect(findProviderCapabilityDescriptor(undefined)).toBeNull();
    expect(findProviderCapabilityDescriptor("")).toBeNull();
    expect(findProviderCapabilityDescriptor("sandbox")).toBeNull();
    expect(findProviderCapabilityDescriptor("sandbox_mock")).toBeNull();
    expect(findProviderCapabilityDescriptor("some_future_provider")).toBeNull();
  });

  it("findProviderCapabilityDescriptor resolves 'adyen' to the real, production descriptor", () => {
    expect(findProviderCapabilityDescriptor("adyen")).toMatchObject({ providerName: "adyen", environment: "production" });
  });

  it("providerSupportsCapability correctly distinguishes capabilities a descriptor does and does not declare", () => {
    const descriptor = { providerName: "future_live_provider", environment: "production" as const, capabilities: ["kyc", "kyb"] as const };
    expect(providerSupportsCapability(descriptor, "kyc")).toBe(true);
    expect(providerSupportsCapability(descriptor, "debit_card_issuing")).toBe(false);
  });

  describe("assertProviderAvailableForRuntime — exactly two outcomes, never a third", () => {
    it("throws ProviderNotAvailableError (never falls back to sandbox) when no provider name is given, in every environment", () => {
      for (const appEnv of ["development", "test", "staging", "production"]) {
        expect(() => assertProviderAvailableForRuntime("payment", undefined, appEnv)).toThrow(ProviderNotAvailableError);
        expect(() => assertProviderAvailableForRuntime("kyc", undefined, appEnv)).toThrow(ProviderNotAvailableError);
        expect(() => assertProviderAvailableForRuntime("card_issuing", undefined, appEnv)).toThrow(ProviderNotAvailableError);
      }
    });

    it("throws ProviderNotAvailableError when the requested provider name is 'sandbox' — it is not registered and never will be", () => {
      expect(() => assertProviderAvailableForRuntime("payment", "sandbox", "production")).toThrow(ProviderNotAvailableError);
    });

    it("throws ProviderNotAvailableError for any unregistered name, in every environment including production", () => {
      for (const appEnv of ["development", "test", "staging", "production"]) {
        expect(() => assertProviderAvailableForRuntime("payment", "some_future_provider", appEnv)).toThrow(ProviderNotAvailableError);
      }
    });

    it("the thrown ProviderNotAvailableError is a 503, operational error — never presented as a generic 500 bug", () => {
      try {
        assertProviderAvailableForRuntime("payment", undefined, "production");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderNotAvailableError);
        expect((error as ProviderNotAvailableError).statusCode).toBe(503);
        expect((error as ProviderNotAvailableError).code).toBe("PROVIDER_NOT_AVAILABLE");
        expect((error as ProviderNotAvailableError).isOperational).toBe(true);
      }
    });

    it("an unregistered name (e.g. 'sandbox') always throws ProviderNotAvailableError, never a silent substitute and never a ConfigurationError (that error is reserved for a REGISTERED provider misplaced across environments — see the next test)", () => {
      try {
        assertProviderAvailableForRuntime("payment", "sandbox", "production");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderNotAvailableError);
        expect(error).not.toBeInstanceOf(ConfigurationError);
      }
    });

    it("PAID2YOU — B0-D ADYEN PHASE 1: 'adyen' resolves successfully in production — the one real, registered, live provider", () => {
      const descriptor = assertProviderAvailableForRuntime("payment", "adyen", "production");
      expect(descriptor).toMatchObject({ providerName: "adyen", environment: "production" });
    });

    it("PAID2YOU — B0-D ADYEN PHASE 1: 'adyen' (a real, environment:'production' descriptor) throws ConfigurationError — not ProviderNotAvailableError — when constructed outside a genuine production deployment", () => {
      for (const appEnv of ["development", "test", "staging"]) {
        try {
          assertProviderAvailableForRuntime("payment", "adyen", appEnv);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigurationError);
          expect(error).not.toBeInstanceOf(ProviderNotAvailableError);
        }
      }
    });

    it("PAID2YOU — B0-D ADYEN PHASE 1: 'adyen' requested for the wrong kind (e.g. 'kyc') still resolves the descriptor (the registry is a flat name lookup, not partitioned by kind) — the caller (getKycProvider.ts) is responsible for rejecting a descriptor with no matching factory, which it does", () => {
      const descriptor = assertProviderAvailableForRuntime("kyc", "adyen", "production");
      expect(descriptor.providerName).toBe("adyen");
      expect(providerSupportsCapability(descriptor, "kyc")).toBe(false);
    });
  });
});
