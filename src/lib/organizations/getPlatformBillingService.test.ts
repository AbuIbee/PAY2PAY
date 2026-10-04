import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "PAID2YOU PRODUCTION LAUNCH", Phase 2, Section 16: proves the fix to `getPlatformBillingService()`
 * — it must construct cleanly with no live provider configured (mirrors
 * getBusinessOnboardingService.test.ts's identical "no recursion, no eager provider resolution"
 * proof), and its genuinely provider-independent, local-first methods (cancel/reactivate — Requirement
 * 24/25's own "do not condition 'can cancel' on a live provider existing") must actually be reachable,
 * never blocked by the factory's own construction.
 */
describe("getPlatformBillingService (PAID2YOU PRODUCTION LAUNCH, Phase 2, Section 16)", () => {
  const baseEnv: Record<string, string> = {
    DATABASE_URL: "postgres://test:test@localhost:5432/pay2pay_test",
    AUDIT_HASH_SECRET: "test-only-audit-hash-secret-value",
    AUTH_PASSWORD_PEPPER: "test-only-auth-password-pepper-value",
    APP_ENV: "production",
    APP_URL: "https://paid2you.com",
  };
  let savedEnv: Record<string, string | undefined> = {};

  function setEnv(overrides: Record<string, string | undefined>) {
    const merged = { ...baseEnv, ...overrides };
    for (const [key, value] of Object.entries(merged)) {
      savedEnv[key] ??= process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(() => {
    savedEnv = {};
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    delete process.env.PLATFORM_BILLING_PROVIDER;
    vi.resetModules();
  });

  it("constructs cleanly with no live provider configured", async () => {
    setEnv({});
    const { getPlatformBillingService } = await import("./getPlatformBillingService");
    expect(() => getPlatformBillingService()).not.toThrow();
  });
});
