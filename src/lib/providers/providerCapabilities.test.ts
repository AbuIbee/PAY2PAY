import { describe, expect, it } from "vitest";
import { ProviderNotAvailableError } from "@/lib/errors";
import {
  assertProviderAvailableForRuntime,
  findProviderCapabilityDescriptor,
  PROVIDER_CAPABILITY_REGISTRY,
  providerSupportsCapability,
  type ProviderCapabilityDescriptor,
  type ProviderKind,
} from "./providerCapabilities";

/**
 * V3 bank-managed-payments architecture (security transfer, SC-01): this test file previously
 * exercised a PRSprint-21-era API (`getProviderCapabilityDescriptor`, `assertProviderEnvironmentConsistency`)
 * that assumed a sandbox descriptor was always registered and permitted in every environment, including
 * production. Both the registry's actual shape (now empty — no live provider approved yet) and the
 * function names/signatures changed when that permissive default was removed; this file was left
 * asserting the old, no-longer-true behavior against functions that no longer exist. Rewritten here to
 * test the CURRENT, correct fail-closed contract instead of reintroducing the retired API.
 */
describe("providerCapabilities (SC-01 — total sandbox elimination / fail-closed provider registry)", () => {
  it("the registry is empty — no sandbox, mock, or unapproved live provider is registered", () => {
    expect(Object.keys(PROVIDER_CAPABILITY_REGISTRY)).toHaveLength(0);
  });

  it("findProviderCapabilityDescriptor returns null for any name — including every retired sandbox name — never a stale descriptor", () => {
    for (const name of ["sandbox_mock", "sandbox_kyc_mock", "sandbox_card_mock", "some_future_provider", "", undefined]) {
      expect(findProviderCapabilityDescriptor(name)).toBeNull();
    }
  });

  it("providerSupportsCapability correctly distinguishes capabilities a descriptor does and does not declare (pure function, no registry dependency)", () => {
    const descriptor: ProviderCapabilityDescriptor = {
      providerName: "future_live_provider",
      environment: "production",
      capabilities: ["kyc", "kyb"],
    };
    expect(providerSupportsCapability(descriptor, "kyc")).toBe(true);
    expect(providerSupportsCapability(descriptor, "kyb")).toBe(true);
    expect(providerSupportsCapability(descriptor, "debit_card_issuing")).toBe(false);
  });

  it("assertProviderAvailableForRuntime throws ProviderNotAvailableError for every kind, for an unregistered/undefined name, in every environment — no sandbox fallback branch exists", () => {
    for (const kind of ["payment", "kyc", "card_issuing"] as const satisfies readonly ProviderKind[]) {
      for (const providerName of ["sandbox_mock", "sandbox", "some_future_provider", undefined]) {
        for (const appEnv of ["development", "test", "staging", "production"]) {
          expect(() => assertProviderAvailableForRuntime(kind, providerName, appEnv)).toThrow(ProviderNotAvailableError);
        }
      }
    }
  });

  it("every registered provider's descriptor.providerName matches its own registry key — the registry can never resolve a provider under the wrong name (vacuously true today; guards the shape once a live provider is registered)", () => {
    for (const [key, descriptor] of Object.entries(PROVIDER_CAPABILITY_REGISTRY)) {
      expect(descriptor.providerName).toBe(key);
    }
  });

  // NOTE: assertProviderAvailableForRuntime's second outcome — a registered `environment: "production"`
  // descriptor constructed outside a genuine production APP_ENV throws `ConfigurationError`, distinct
  // from the `ProviderNotAvailableError` an unregistered name throws (see that function's own doc
  // comment) — cannot be directly exercised while PROVIDER_CAPABILITY_REGISTRY is empty, since there is
  // no registered descriptor to construct. Add a direct test for that branch here once a real provider
  // is registered.
});
