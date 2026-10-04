import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAID2YOU OWNER DIRECTIVE (2026-10-03) — ADYEN RETIRED: bank-linking (`BankConnectionService`) was
 * built entirely on top of Adyen's own bank-account tokenization capability (B0-D ADYEN PHASE 2/2A) —
 * with Adyen retired from `providerCapabilities.ts`'s registry, `getPaymentProvider()` now always
 * throws `ProviderNotAvailableError` before `getBankConnectionService()` ever reaches its own
 * `ADYEN_ACH_TOKENIZATION_VERIFIED` check, so bank-linking is now unconditionally unavailable —
 * proven below even with an otherwise-complete-looking legacy Adyen configuration. The owner-approved
 * repayment-money-movement direction going forward (Direct Banking: FedNow/RTP/Request for Payment)
 * has not yet been implemented — this factory has no live bank-linking path at all right now, which is
 * the correct, honest, fail-closed state, never a silent "bank-linking enabled anyway." Mirrors
 * getPaymentProvider.test.ts's identical `vi.resetModules()` pattern.
 */
describe("getBankConnectionService / getBankConnectionServiceIfAvailable (PAID2YOU OWNER DIRECTIVE — ADYEN RETIRED)", () => {
  const LEGACY_ADYEN_CONFIG: Record<string, string> = {
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
    const merged = { ...LEGACY_ADYEN_CONFIG, ...overrides };
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

  it("fails closed with ProviderNotAvailableError when ADYEN_ACH_TOKENIZATION_VERIFIED is unset", async () => {
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

  it("ADYEN RETIRED: fails closed EVEN with the legacy ADYEN_ACH_TOKENIZATION_VERIFIED=true flag set — Adyen's own registry entry is gone, so that flag alone can no longer make bank-linking available", async () => {
    setEnv({ ADYEN_ACH_TOKENIZATION_VERIFIED: "true" });
    const { getBankConnectionService } = await import("./getBankConnectionService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getBankConnectionService()).toThrow(ProviderNotAvailableError);
  });

  it("getBankConnectionServiceIfAvailable returns null (never throws) regardless of the legacy Adyen flag — so ordinary payment webhook processing never breaks", async () => {
    for (const verified of [undefined, "false", "true"]) {
      vi.resetModules();
      setEnv({ ADYEN_ACH_TOKENIZATION_VERIFIED: verified });
      const { getBankConnectionServiceIfAvailable } = await import("./getBankConnectionService");
      expect(getBankConnectionServiceIfAvailable()).toBeNull();
    }
  });
});
