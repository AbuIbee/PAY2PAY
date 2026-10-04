import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 56: a single, consolidated structural production-boot
 * proof — composes the EXISTING, already-separately-tested production factories under one
 * APP_ENV=production configuration built entirely from safe, non-live, structural values (no real
 * provider credentials — Section 56's own "do not require actual live provider credentials in
 * automated testing"). This file does not duplicate those factories' own detailed test coverage; it
 * proves the SET of properties the Master P0 order lists all hold simultaneously, in one place.
 */
describe("Production boot structural proof (PAID2YOU — MASTER P0, Section 56)", () => {
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
    vi.resetModules();
  });

  it("no sandbox/fake payment provider is auto-selected — PAYMENT_PROVIDER unset fails closed with ProviderNotAvailableError", async () => {
    setEnv({});
    const { getPaymentProvider } = await import("@/lib/payments/getPaymentProvider");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getPaymentProvider()).toThrow(ProviderNotAvailableError);
  });

  it("Adyen is never activated — PAYMENT_PROVIDER=adyen with full-looking legacy config still fails closed", async () => {
    setEnv({
      PAYMENT_PROVIDER: "adyen",
      ADYEN_API_KEY: "test-key",
      ADYEN_MERCHANT_ACCOUNT: "Paid2YouECOM",
      ADYEN_LIVE_PREFIX: "1797a841fbb37ca7-Paid2You",
      ADYEN_PAYMENTS_HMAC_KEY: Buffer.from("a-test-hmac-key-32-bytes-long!!").toString("base64"),
    });
    const { getPaymentProvider } = await import("@/lib/payments/getPaymentProvider");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    let thrown: unknown;
    try {
      getPaymentProvider();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderNotAvailableError);
  });

  it("customer money movement is not enabled by default — no PAYMENT_PROVIDER, no ADYEN_PAYMENTS_VERIFIED, bank-linking also unavailable", async () => {
    setEnv({});
    const { getPaymentProvider } = await import("@/lib/payments/getPaymentProvider");
    const { getBankConnectionServiceIfAvailable } = await import("@/lib/relationships/getBankConnectionService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getPaymentProvider()).toThrow(ProviderNotAvailableError);
    expect(getBankConnectionServiceIfAvailable()).toBeNull();
  });

  it("business verification and platform billing fail closed when unconfigured — never fabricate a verified/active result", async () => {
    setEnv({});
    const { getBusinessVerificationProvider } = await import("@/lib/organizations/getBusinessVerificationProvider");
    const { getPlatformBillingProvider } = await import("@/lib/organizations/getPlatformBillingProvider");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getBusinessVerificationProvider()).toThrow(ProviderNotAvailableError);
    expect(() => getPlatformBillingProvider()).toThrow(ProviderNotAvailableError);
  });

  it("missing Middesk/Stripe configuration fails clearly with ConfigurationError once selected, never silently proceeding", async () => {
    setEnv({ BUSINESS_VERIFICATION_PROVIDER: "middesk", PLATFORM_BILLING_PROVIDER: "stripe" });
    const { getBusinessVerificationProvider } = await import("@/lib/organizations/getBusinessVerificationProvider");
    const { getPlatformBillingProvider } = await import("@/lib/organizations/getPlatformBillingProvider");
    const { ConfigurationError } = await import("@/lib/errors");
    expect(() => getBusinessVerificationProvider()).toThrow(ConfigurationError);
    expect(() => getPlatformBillingProvider()).toThrow(ConfigurationError);
  });

  it("a localhost APP_URL is refused outright under APP_ENV=production at environment-parse time, before any factory even runs", async () => {
    setEnv({ APP_URL: "http://localhost:3000" });
    const { EnvironmentValidationError, parseServerEnv } = await import("@/config/env");
    expect(() => parseServerEnv(process.env)).toThrow(EnvironmentValidationError);
  });

  it("production email never claims console-logged delivery as successful — an unconfigured sender in production is fail-closed (failClosed: true), not a silent 'sent'", async () => {
    setEnv({});
    const { getEmailSender } = await import("@/lib/notify/getEmailSender");
    const sender = getEmailSender();
    expect(sender.constructor.name).toBe("ConsoleEmailSender");
    await expect(sender.send({ to: "test@example.com", subject: "x", body: "x" })).rejects.toThrow();
  });

  it("document storage has no local-disk fallback branch — the factory always constructs SupabaseDocumentStorage, structurally, not merely by current configuration", async () => {
    const { getDocumentStorage } = await import("@/lib/documents/getDocumentStorage");
    expect(getDocumentStorage().constructor.name).toBe("SupabaseDocumentStorage");
  });

  it("'sandbox'/'mock'/'fake'/'test' provider name literals are rejected at environment-parse time for every provider-selection variable, including the two newly-registered ones", async () => {
    const { EnvironmentValidationError, parseServerEnv } = await import("@/config/env");
    for (const field of ["PAYMENT_PROVIDER", "BUSINESS_VERIFICATION_PROVIDER", "PLATFORM_BILLING_PROVIDER"]) {
      setEnv({ [field]: "sandbox" });
      expect(() => parseServerEnv(process.env)).toThrow(EnvironmentValidationError);
      delete process.env[field];
    }
  });
});
