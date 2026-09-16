import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction, item 3 — ACH VALIDATION EXTERNAL
 * BLOCKER). Proves the real production factory body — never a hand-assembled substitute — fails
 * closed (ProviderNotAvailableError, not a silent "bank-linking enabled anyway") whenever
 * `ADYEN_ACH_TOKENIZATION_VERIFIED` is not explicitly `"true"`, regardless of how complete the rest of
 * the Adyen configuration is. This env var is the concrete gate standing in for an external,
 * Adyen-side, unverifiable-by-this-codebase fact (zero-value ACH authorization + GIACT activation for
 * the real merchant account) — see that var's own doc comment in src/config/env.ts. Mirrors
 * getPaymentProvider.test.ts's identical `vi.resetModules()` pattern so both this module's own
 * `cached` singleton and src/config/env.ts's `cachedServerEnv` start fresh, exactly like a real cold
 * server process.
 */
describe("getBankConnectionService / getBankConnectionServiceIfAvailable (PAID2YOU — B0-D ADYEN PHASE 2A)", () => {
  const FULL_ADYEN_CONFIG: Record<string, string> = {
    DATABASE_URL: "postgres://test:test@localhost:5432/pay2pay_test",
    AUDIT_HASH_SECRET: "test-only-audit-hash-secret-value",
    AUTH_PASSWORD_PEPPER: "test-only-auth-password-pepper-value",
    APP_ENV: "production",
    APP_URL: "https://paid2you.com",
    PAYMENT_PROVIDER: "adyen",
    ADYEN_API_KEY: "test-key",
    ADYEN_MERCHANT_ACCOUNT: "Paid2YouECOM",
    ADYEN_LIVE_PREFIX: "1797a841fbb37ca7-Paid2You",
    ADYEN_PAYMENTS_HMAC_KEY: Buffer.from("a-test-hmac-key-32-bytes-long!!").toString("base64"),
  };
  let savedEnv: Record<string, string | undefined> = {};

  function setEnv(overrides: Record<string, string | undefined>) {
    const merged = { ...FULL_ADYEN_CONFIG, ...overrides };
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
    delete process.env.ADYEN_ACH_TOKENIZATION_VERIFIED;
    vi.resetModules();
  });

  it("fails closed with ProviderNotAvailableError when ADYEN_ACH_TOKENIZATION_VERIFIED is unset, even with otherwise-complete Adyen configuration", async () => {
    setEnv({});
    const { getBankConnectionService } = await import("./getBankConnectionService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getBankConnectionService()).toThrow(ProviderNotAvailableError);
  });

  it("fails closed the same way when explicitly ADYEN_ACH_TOKENIZATION_VERIFIED=false", async () => {
    setEnv({ ADYEN_ACH_TOKENIZATION_VERIFIED: "false" });
    const { getBankConnectionService } = await import("./getBankConnectionService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getBankConnectionService()).toThrow(ProviderNotAvailableError);
  });

  it("never assumes approval from APP_ENV alone — production with no explicit verification flag still fails closed", async () => {
    setEnv({ APP_ENV: "production" });
    const { getBankConnectionService } = await import("./getBankConnectionService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getBankConnectionService()).toThrow(ProviderNotAvailableError);
  });

  it("constructs a real BankConnectionService once an operator has explicitly set ADYEN_ACH_TOKENIZATION_VERIFIED=true, on top of complete Adyen configuration", async () => {
    setEnv({ ADYEN_ACH_TOKENIZATION_VERIFIED: "true" });
    const { getBankConnectionService } = await import("./getBankConnectionService");
    const { BankConnectionService } = await import("./bankConnectionService");
    expect(getBankConnectionService()).toBeInstanceOf(BankConnectionService);
  });

  it("getBankConnectionServiceIfAvailable returns null (never throws) while bank-linking is gated off — so ordinary payment webhook processing never breaks", async () => {
    setEnv({});
    const { getBankConnectionServiceIfAvailable } = await import("./getBankConnectionService");
    expect(getBankConnectionServiceIfAvailable()).toBeNull();
  });

  it("getBankConnectionServiceIfAvailable returns a real instance once verified", async () => {
    setEnv({ ADYEN_ACH_TOKENIZATION_VERIFIED: "true" });
    const { getBankConnectionServiceIfAvailable } = await import("./getBankConnectionService");
    const { BankConnectionService } = await import("./bankConnectionService");
    expect(getBankConnectionServiceIfAvailable()).toBeInstanceOf(BankConnectionService);
  });
});
