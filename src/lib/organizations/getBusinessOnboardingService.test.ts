import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02). Mirrors getAgreementWorkspaceService.test.ts's own
 * established "cold call constructs cleanly" pattern — AND proves the specific defect this phase's
 * own design fixed: getBusinessVerificationProvider()/getPlatformBillingProvider() both throw
 * `ProviderNotAvailableError` today (no provider registered). If BusinessOnboardingService's
 * constructor resolved those eagerly instead of via a lazy thunk, THIS cold call would throw —
 * breaking Business Details submission (and every other onboarding step) merely because an
 * unrelated, later step's provider isn't configured yet.
 */
describe("PAID2YOU — getBusinessOnboardingService production factory wiring (no recursion, no eager provider resolution)", () => {
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

  it("a cold call constructs cleanly even though the verification and billing providers are both NOT_CONFIGURED", async () => {
    const { getBusinessOnboardingService } = await import("./getBusinessOnboardingService");
    expect(() => getBusinessOnboardingService()).not.toThrow();
  });

  it("is memoized — a second cold-path call returns the same instance", async () => {
    const { getBusinessOnboardingService } = await import("./getBusinessOnboardingService");
    const first = getBusinessOnboardingService();
    const second = getBusinessOnboardingService();
    expect(first).toBe(second);
  });

  it("the underlying activation/role/billing factories each construct cleanly too", async () => {
    const { getBusinessActivationService } = await import("./getBusinessActivationService");
    const { getOrganizationRoleService } = await import("./getOrganizationRoleService");
    expect(() => getBusinessActivationService()).not.toThrow();
    expect(() => getOrganizationRoleService()).not.toThrow();
    // getPlatformBillingService/getBusinessVerificationService are NOT exercised directly here —
    // they are expected to throw ProviderNotAvailableError when actually CALLED (NOT_CONFIGURED),
    // which is correct; only BusinessOnboardingService's own construction must stay unaffected by
    // that, and the test above already proves it.
  });
});
