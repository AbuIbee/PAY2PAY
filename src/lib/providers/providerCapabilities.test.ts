import { describe, expect, it } from "vitest";
import { ConfigurationError, ProviderNotAvailableError } from "@/lib/errors";
import {
  assertProviderAvailableForRuntime,
  findProviderCapabilityDescriptor,
  PROVIDER_CAPABILITY_REGISTRY,
  providerSupportsCapability,
} from "./providerCapabilities";

describe("providerCapabilities (PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION)", () => {
  it("PAID2YOU — MASTER P0 (2026-10-03): the registry holds exactly the two owner-approved production entries — 'middesk' (business verification) and 'stripe' (Paid2You's OWN subscription billing) — no sandbox, no Adyen, no payment-kind entry", () => {
    expect(Object.keys(PROVIDER_CAPABILITY_REGISTRY).sort()).toEqual(["middesk", "stripe"]);
    expect(PROVIDER_CAPABILITY_REGISTRY.middesk).toEqual({ providerName: "middesk", environment: "production", capabilities: ["kyb"] });
    expect(PROVIDER_CAPABILITY_REGISTRY.stripe).toEqual({ providerName: "stripe", environment: "production", capabilities: ["webhook_delivery"] });
  });

  it("findProviderCapabilityDescriptor returns null for any unregistered name, including undefined, every retired sandbox name, and the retired 'adyen' name itself", () => {
    expect(findProviderCapabilityDescriptor(undefined)).toBeNull();
    expect(findProviderCapabilityDescriptor("")).toBeNull();
    expect(findProviderCapabilityDescriptor("sandbox")).toBeNull();
    expect(findProviderCapabilityDescriptor("sandbox_mock")).toBeNull();
    expect(findProviderCapabilityDescriptor("some_future_provider")).toBeNull();
    expect(findProviderCapabilityDescriptor("adyen")).toBeNull();
  });

  it("'middesk'/'stripe' are registered ONLY for their own kind's resolution path — this registry performs no kind-isolation itself (assertProviderAvailableForRuntime's own `kind` argument is just a label), so the REAL isolation is structural: getPaymentProvider.ts never passes 'middesk'/'stripe' as a candidate PAYMENT_PROVIDER value, and no production code path does either", () => {
    // Documented, not re-asserted here mechanically — see getPaymentProvider.ts/getBusinessVerificationProvider.ts/getPlatformBillingProvider.ts's own tests for the per-factory wiring proof.
    expect(findProviderCapabilityDescriptor("middesk")?.providerName).toBe("middesk");
    expect(findProviderCapabilityDescriptor("stripe")?.providerName).toBe("stripe");
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

    it("PAID2YOU OWNER DIRECTIVE (2026-10-03) — ADYEN RETIRED: 'adyen' no longer resolves in ANY environment, including production — it throws ProviderNotAvailableError exactly like any other unregistered name now", () => {
      for (const appEnv of ["development", "test", "staging", "production"]) {
        expect(() => assertProviderAvailableForRuntime("payment", "adyen", appEnv)).toThrow(ProviderNotAvailableError);
      }
    });

    it("'adyen' requested for any kind (e.g. 'kyc') is likewise always unavailable now — the registry has no entry for it at all", () => {
      expect(() => assertProviderAvailableForRuntime("kyc", "adyen", "production")).toThrow(ProviderNotAvailableError);
    });
  });
});
