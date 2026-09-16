import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION — mirrors getPaymentProvider.test.ts's identical pattern and rationale. */
describe("getKycProvider (PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION)", () => {
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
    delete process.env.KYC_PROVIDER;
    vi.resetModules();
  });

  it("throws ProviderNotAvailableError when KYC_PROVIDER is unset — never substitutes sandbox", async () => {
    setEnv({});
    const { getKycProvider } = await import("./getKycProvider");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getKycProvider()).toThrow(ProviderNotAvailableError);
  });

  it("environment parsing itself rejects KYC_PROVIDER=sandbox before the factory even runs", async () => {
    setEnv({ KYC_PROVIDER: "sandbox" });
    const { getKycProvider } = await import("./getKycProvider");
    const { EnvironmentValidationError } = await import("@/config/env");
    expect(() => getKycProvider()).toThrow(EnvironmentValidationError);
  });

  it("fails closed the same way regardless of APP_ENV", async () => {
    for (const appEnv of ["development", "test", "staging", "production"]) {
      vi.resetModules();
      setEnv({ APP_ENV: appEnv });
      const { getKycProvider } = await import("./getKycProvider");
      const { ProviderNotAvailableError } = await import("@/lib/errors");
      expect(() => getKycProvider()).toThrow(ProviderNotAvailableError);
    }
  });
});
