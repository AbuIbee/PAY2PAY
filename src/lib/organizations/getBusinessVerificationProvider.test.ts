import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "PAID2YOU PRODUCTION LAUNCH", Phase 1, Section 10: mirrors getKycProvider.test.ts's identical
 * pattern/rationale (PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION) — a structural proof that the
 * production factory can never select a sandbox/test provider through normal production
 * configuration, for this B2B-expansion provider.
 */
describe("getBusinessVerificationProvider (PAID2YOU PRODUCTION LAUNCH, Section 10)", () => {
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
    delete process.env.BUSINESS_VERIFICATION_PROVIDER;
    vi.resetModules();
  });

  it("throws ProviderNotAvailableError when BUSINESS_VERIFICATION_PROVIDER is unset — never substitutes sandbox", async () => {
    setEnv({});
    const { getBusinessVerificationProvider } = await import("./getBusinessVerificationProvider");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getBusinessVerificationProvider()).toThrow(ProviderNotAvailableError);
  });

  it("environment parsing itself rejects BUSINESS_VERIFICATION_PROVIDER=sandbox before the factory even runs", async () => {
    setEnv({ BUSINESS_VERIFICATION_PROVIDER: "sandbox" });
    const { getBusinessVerificationProvider } = await import("./getBusinessVerificationProvider");
    const { EnvironmentValidationError } = await import("@/config/env");
    expect(() => getBusinessVerificationProvider()).toThrow(EnvironmentValidationError);
  });

  it("fails closed the same way regardless of APP_ENV", async () => {
    for (const appEnv of ["development", "test", "staging", "production"]) {
      vi.resetModules();
      setEnv({ APP_ENV: appEnv });
      const { getBusinessVerificationProvider } = await import("./getBusinessVerificationProvider");
      const { ProviderNotAvailableError } = await import("@/lib/errors");
      expect(() => getBusinessVerificationProvider()).toThrow(ProviderNotAvailableError);
    }
  });

  describe("PAID2YOU — MASTER P0 (2026-10-03): Middesk wiring", () => {
    afterEach(() => {
      delete process.env.MIDDESK_API_KEY;
      delete process.env.MIDDESK_WEBHOOK_SECRET;
    });

    it("BUSINESS_VERIFICATION_PROVIDER=middesk with neither secret configured fails closed with ConfigurationError, never ProviderNotAvailableError (the descriptor IS registered — this is a real misconfiguration, not 'not available yet')", async () => {
      setEnv({ BUSINESS_VERIFICATION_PROVIDER: "middesk" });
      const { getBusinessVerificationProvider } = await import("./getBusinessVerificationProvider");
      const { ConfigurationError } = await import("@/lib/errors");
      expect(() => getBusinessVerificationProvider()).toThrow(ConfigurationError);
    });

    it("BUSINESS_VERIFICATION_PROVIDER=middesk with only MIDDESK_API_KEY (no webhook secret) still fails closed", async () => {
      setEnv({ BUSINESS_VERIFICATION_PROVIDER: "middesk", MIDDESK_API_KEY: "test-key" });
      const { getBusinessVerificationProvider } = await import("./getBusinessVerificationProvider");
      const { ConfigurationError } = await import("@/lib/errors");
      expect(() => getBusinessVerificationProvider()).toThrow(ConfigurationError);
    });

    it("BUSINESS_VERIFICATION_PROVIDER=middesk with both secrets configured constructs a real MiddeskBusinessVerificationProvider", async () => {
      setEnv({ BUSINESS_VERIFICATION_PROVIDER: "middesk", MIDDESK_API_KEY: "test-key", MIDDESK_WEBHOOK_SECRET: "a-test-webhook-secret-value" });
      const { getBusinessVerificationProvider } = await import("./getBusinessVerificationProvider");
      const provider = getBusinessVerificationProvider();
      expect(provider.providerName).toBe("middesk");
      expect(provider.providerEnvironment).toBe("production");
    });

    it("isBusinessVerificationProviderConfigured reflects real configuration state without throwing", async () => {
      setEnv({});
      const { isBusinessVerificationProviderConfigured } = await import("./getBusinessVerificationProvider");
      expect(isBusinessVerificationProviderConfigured()).toBe(false);
    });
  });
});
