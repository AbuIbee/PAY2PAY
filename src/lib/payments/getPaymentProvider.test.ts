import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION: proves the real production factory body — never a
 * hand-assembled substitute — can no longer construct a sandbox payment provider under any
 * configuration, and fails closed (ProviderNotAvailableError, not a silent fallback) instead.
 * `vi.resetModules()` before each test mirrors productionFactoryRecursion.test.ts's identical pattern
 * so both this module's own `cached` singleton and src/config/env.ts's `cachedServerEnv` start fresh,
 * exactly like a real cold server process.
 */
describe("getPaymentProvider (PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION)", () => {
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
    delete process.env.PAYMENT_PROVIDER;
    vi.resetModules();
  });

  it("throws ProviderNotAvailableError when PAYMENT_PROVIDER is unset — never substitutes sandbox", async () => {
    setEnv({});
    const { getPaymentProvider } = await import("./getPaymentProvider");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getPaymentProvider()).toThrow(ProviderNotAvailableError);
  });

  it("environment parsing itself rejects PAYMENT_PROVIDER=sandbox before the factory even runs", async () => {
    setEnv({ PAYMENT_PROVIDER: "sandbox" });
    const { getPaymentProvider } = await import("./getPaymentProvider");
    const { EnvironmentValidationError } = await import("@/config/env");
    expect(() => getPaymentProvider()).toThrow(EnvironmentValidationError);
  });

  it("throws ProviderNotAvailableError for an unregistered, non-forbidden provider name too — only 'adyen' is registered", async () => {
    setEnv({ PAYMENT_PROVIDER: "acme_payments_live" });
    const { getPaymentProvider } = await import("./getPaymentProvider");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getPaymentProvider()).toThrow(ProviderNotAvailableError);
  });

  it("never returns a SandboxPaymentProvider instance (there is no code path that could construct one)", async () => {
    setEnv({});
    const { getPaymentProvider } = await import("./getPaymentProvider");
    let thrown: unknown;
    try {
      getPaymentProvider();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).constructor.name).not.toBe("SandboxPaymentProvider");
  });

  it("fails closed the same way (ProviderNotAvailableError) regardless of APP_ENV — no development/staging override restores sandbox behavior", async () => {
    for (const appEnv of ["development", "test", "staging", "production"]) {
      vi.resetModules();
      setEnv({ APP_ENV: appEnv });
      const { getPaymentProvider } = await import("./getPaymentProvider");
      const { ProviderNotAvailableError } = await import("@/lib/errors");
      expect(() => getPaymentProvider()).toThrow(ProviderNotAvailableError);
    }
  });

  describe("PAID2YOU — B0-D ADYEN PHASE 1", () => {
    const ADYEN_CONFIG: Record<string, string> = {
      PAYMENT_PROVIDER: "adyen",
      ADYEN_API_KEY: "test-key",
      ADYEN_MERCHANT_ACCOUNT: "Paid2YouECOM",
      ADYEN_LIVE_PREFIX: "1797a841fbb37ca7-Paid2You",
      ADYEN_PAYMENTS_HMAC_KEY: Buffer.from("a-test-hmac-key-32-bytes-long!!").toString("base64"),
    };

    afterEach(() => {
      for (const key of Object.keys(ADYEN_CONFIG)) delete process.env[key];
    });

    it("PAYMENT_PROVIDER=adyen + full valid config -> constructs a real AdyenPaymentProvider", async () => {
      setEnv(ADYEN_CONFIG);
      const { getPaymentProvider } = await import("./getPaymentProvider");
      const { AdyenPaymentProvider } = await import("./adyenPaymentProvider");
      const provider = getPaymentProvider();
      expect(provider).toBeInstanceOf(AdyenPaymentProvider);
      expect(provider.providerName).toBe("adyen");
      expect(provider.providerEnvironment).toBe("production");
    });

    it("PAYMENT_PROVIDER=adyen + missing ADYEN_API_KEY -> fails closed with ConfigurationError, not a silent construction", async () => {
      setEnv({ ...ADYEN_CONFIG, ADYEN_API_KEY: undefined });
      const { getPaymentProvider } = await import("./getPaymentProvider");
      const { ConfigurationError } = await import("@/lib/errors");
      expect(() => getPaymentProvider()).toThrow(ConfigurationError);
    });

    it("PAYMENT_PROVIDER=adyen + missing ADYEN_MERCHANT_ACCOUNT -> fails closed with ConfigurationError", async () => {
      setEnv({ ...ADYEN_CONFIG, ADYEN_MERCHANT_ACCOUNT: undefined });
      const { getPaymentProvider } = await import("./getPaymentProvider");
      const { ConfigurationError } = await import("@/lib/errors");
      expect(() => getPaymentProvider()).toThrow(ConfigurationError);
    });

    it("PAYMENT_PROVIDER=adyen + missing ADYEN_LIVE_PREFIX -> fails closed with ConfigurationError", async () => {
      setEnv({ ...ADYEN_CONFIG, ADYEN_LIVE_PREFIX: undefined });
      const { getPaymentProvider } = await import("./getPaymentProvider");
      const { ConfigurationError } = await import("@/lib/errors");
      expect(() => getPaymentProvider()).toThrow(ConfigurationError);
    });

    it("PAYMENT_PROVIDER=adyen + missing ADYEN_PAYMENTS_HMAC_KEY -> fails closed with ConfigurationError", async () => {
      setEnv({ ...ADYEN_CONFIG, ADYEN_PAYMENTS_HMAC_KEY: undefined });
      const { getPaymentProvider } = await import("./getPaymentProvider");
      const { ConfigurationError } = await import("@/lib/errors");
      expect(() => getPaymentProvider()).toThrow(ConfigurationError);
    });

    it("PAYMENT_PROVIDER=adyen outside a genuine production deployment -> ConfigurationError (a real, registered provider misplaced across environments), never silently constructed", async () => {
      for (const appEnv of ["development", "test", "staging"]) {
        vi.resetModules();
        setEnv({ ...ADYEN_CONFIG, APP_ENV: appEnv });
        const { getPaymentProvider } = await import("./getPaymentProvider");
        const { ConfigurationError } = await import("@/lib/errors");
        expect(() => getPaymentProvider()).toThrow(ConfigurationError);
      }
    });
  });
});
