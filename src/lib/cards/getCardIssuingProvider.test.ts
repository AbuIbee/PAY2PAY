import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION — mirrors getPaymentProvider.test.ts's identical pattern and rationale. */
describe("getCardIssuingProvider (PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION)", () => {
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
    delete process.env.CARD_ISSUING_PROVIDER;
    vi.resetModules();
  });

  it("throws ProviderNotAvailableError when CARD_ISSUING_PROVIDER is unset — never substitutes sandbox", async () => {
    setEnv({});
    const { getCardIssuingProvider } = await import("./getCardIssuingProvider");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getCardIssuingProvider()).toThrow(ProviderNotAvailableError);
  });

  it("environment parsing itself rejects CARD_ISSUING_PROVIDER=sandbox before the factory even runs", async () => {
    setEnv({ CARD_ISSUING_PROVIDER: "sandbox" });
    const { getCardIssuingProvider } = await import("./getCardIssuingProvider");
    const { EnvironmentValidationError } = await import("@/config/env");
    expect(() => getCardIssuingProvider()).toThrow(EnvironmentValidationError);
  });

  it("fails closed the same way regardless of APP_ENV", async () => {
    for (const appEnv of ["development", "test", "staging", "production"]) {
      vi.resetModules();
      setEnv({ APP_ENV: appEnv });
      const { getCardIssuingProvider } = await import("./getCardIssuingProvider");
      const { ProviderNotAvailableError } = await import("@/lib/errors");
      expect(() => getCardIssuingProvider()).toThrow(ProviderNotAvailableError);
    }
  });
});
