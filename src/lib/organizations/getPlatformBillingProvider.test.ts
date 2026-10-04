import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "PAID2YOU PRODUCTION LAUNCH", Phase 1, Section 10: mirrors getKycProvider.test.ts's identical
 * pattern/rationale (PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION) — a structural proof that the
 * production factory can never select a sandbox/test provider through normal production
 * configuration, for this B2B-expansion provider.
 */
describe("getPlatformBillingProvider (PAID2YOU PRODUCTION LAUNCH, Section 10)", () => {
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

  it("throws ProviderNotAvailableError when PLATFORM_BILLING_PROVIDER is unset — never substitutes sandbox", async () => {
    setEnv({});
    const { getPlatformBillingProvider } = await import("./getPlatformBillingProvider");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getPlatformBillingProvider()).toThrow(ProviderNotAvailableError);
  });

  it("environment parsing itself rejects PLATFORM_BILLING_PROVIDER=sandbox before the factory even runs", async () => {
    setEnv({ PLATFORM_BILLING_PROVIDER: "sandbox" });
    const { getPlatformBillingProvider } = await import("./getPlatformBillingProvider");
    const { EnvironmentValidationError } = await import("@/config/env");
    expect(() => getPlatformBillingProvider()).toThrow(EnvironmentValidationError);
  });

  it("fails closed the same way regardless of APP_ENV", async () => {
    for (const appEnv of ["development", "test", "staging", "production"]) {
      vi.resetModules();
      setEnv({ APP_ENV: appEnv });
      const { getPlatformBillingProvider } = await import("./getPlatformBillingProvider");
      const { ProviderNotAvailableError } = await import("@/lib/errors");
      expect(() => getPlatformBillingProvider()).toThrow(ProviderNotAvailableError);
    }
  });

  describe("PAID2YOU — MASTER P0 (2026-10-03): Stripe wiring", () => {
    afterEach(() => {
      for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_STARTER_PRICE_ID", "STRIPE_CORE_PRICE_ID", "STRIPE_GROWTH_PRICE_ID", "STRIPE_SCALE_PRICE_ID"]) {
        delete process.env[key];
      }
    });

    it("PLATFORM_BILLING_PROVIDER=stripe with neither secret configured fails closed with ConfigurationError, never ProviderNotAvailableError (the descriptor IS registered)", async () => {
      setEnv({ PLATFORM_BILLING_PROVIDER: "stripe" });
      const { getPlatformBillingProvider } = await import("./getPlatformBillingProvider");
      const { ConfigurationError } = await import("@/lib/errors");
      expect(() => getPlatformBillingProvider()).toThrow(ConfigurationError);
    });

    it("PLATFORM_BILLING_PROVIDER=stripe with only STRIPE_SECRET_KEY (no webhook secret) still fails closed", async () => {
      setEnv({ PLATFORM_BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_fake" });
      const { getPlatformBillingProvider } = await import("./getPlatformBillingProvider");
      const { ConfigurationError } = await import("@/lib/errors");
      expect(() => getPlatformBillingProvider()).toThrow(ConfigurationError);
    });

    it("PLATFORM_BILLING_PROVIDER=stripe with both secrets configured constructs a real StripePlatformBillingProvider, even with zero price IDs configured (those are enforced lazily, per-plan, only when actually started/changed to)", async () => {
      setEnv({ PLATFORM_BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test_fake" });
      const { getPlatformBillingProvider } = await import("./getPlatformBillingProvider");
      const provider = getPlatformBillingProvider();
      expect(provider.providerName).toBe("stripe");
      expect(provider.providerEnvironment).toBe("production");
    });
  });

  describe("isPlatformBillingProviderConfigured (PAID2YOU PRODUCTION LAUNCH, Phase 2, Section 11)", () => {
    it("is false when no provider is configured — never throws itself", async () => {
      setEnv({});
      const { isPlatformBillingProviderConfigured } = await import("./getPlatformBillingProvider");
      expect(isPlatformBillingProviderConfigured()).toBe(false);
    });
  });

  describe("getLazyPlatformBillingProvider (PAID2YOU PRODUCTION LAUNCH, Phase 2, Section 16)", () => {
    it("constructs without throwing even though no provider is configured", async () => {
      setEnv({});
      const { getLazyPlatformBillingProvider } = await import("./getPlatformBillingProvider");
      expect(() => getLazyPlatformBillingProvider()).not.toThrow();
    });

    it("defers the ProviderNotAvailableError to the moment a method is actually called", async () => {
      setEnv({});
      const { getLazyPlatformBillingProvider } = await import("./getPlatformBillingProvider");
      const { ProviderNotAvailableError } = await import("@/lib/errors");
      const provider = getLazyPlatformBillingProvider();
      await expect(provider.payInvoice("inv-1")).rejects.toThrow(ProviderNotAvailableError);
      await expect(provider.cancelAtPeriodEnd("sub-1")).rejects.toThrow(ProviderNotAvailableError);
    });
  });
});
