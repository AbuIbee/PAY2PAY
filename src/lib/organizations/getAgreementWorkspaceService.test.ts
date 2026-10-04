import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 9 (2026-10-02).
 * Mirrors src/lib/failedPayments/productionFactoryRecursion.test.ts's own established pattern: a
 * cold call to the real production factory, from a genuinely fresh module cache
 * (`vi.resetModules()`), must construct cleanly — never a `RangeError: Maximum call stack size
 * exceeded` from a circular getter chain. getAgreementWorkspaceService -> getAgreementService /
 * getOrganizationAuthorizationService / getEntitlementService -> getStaffService / getPricingService
 * has no cycle back to itself or to any payment/webhook/retry factory; this proves that directly
 * against the real wiring, not merely by inspection.
 */
describe("PAID2YOU — getAgreementWorkspaceService production factory wiring (no recursion)", () => {
  const requiredEnv: Record<string, string> = {
    DATABASE_URL: "postgres://test:test@localhost:5432/pay2pay_test",
    AUDIT_HASH_SECRET: "test-only-audit-hash-secret-value",
    AUTH_PASSWORD_PEPPER: "test-only-auth-password-pepper-value",
    APP_ENV: "test",
    APP_URL: "https://test.example.com",
  };
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of Object.keys(requiredEnv)) {
      savedEnv[key] = process.env[key];
      process.env[key] = requiredEnv[key];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of Object.keys(requiredEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.resetModules();
  });

  it("a cold call constructs cleanly — no RangeError, no circular getter chain", async () => {
    const { getAgreementWorkspaceService } = await import("./getAgreementWorkspaceService");
    expect(() => getAgreementWorkspaceService()).not.toThrow();
  });

  it("is memoized — a second cold-path call returns the same instance", async () => {
    const { getAgreementWorkspaceService } = await import("./getAgreementWorkspaceService");
    const first = getAgreementWorkspaceService();
    const second = getAgreementWorkspaceService();
    expect(first).toBe(second);
  });

  it("the underlying workspace/authorization/entitlement factories each construct cleanly too", async () => {
    const { getOrganizationAuthorizationService } = await import("./getOrganizationAuthorizationService");
    const { getWorkspaceContextService } = await import("./getWorkspaceContextService");
    const { getEntitlementService } = await import("./getEntitlementService");
    expect(() => getOrganizationAuthorizationService()).not.toThrow();
    expect(() => getWorkspaceContextService()).not.toThrow();
    expect(() => getEntitlementService()).not.toThrow();
  });
});
