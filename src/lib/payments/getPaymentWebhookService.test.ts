import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderNotAvailableError } from "@/lib/errors";

/**
 * STAGE 3 G01/G05 (docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md): the real
 * production `getPaymentWebhookService()` factory must construct successfully even when no live
 * payment provider is registered, because `PaymentWebhookService`'s `provider` dependency is only
 * ever read inside `receiveWebhook` (webhook signature verification) — never during construction,
 * and never by `recoverBatch`/`receiveInternalEvent`/`applyEvent`. Mirrors
 * `productionFactoryRecursion.test.ts`'s own module-reset/env conventions; mocks ONLY the
 * `getPaymentProvider` module boundary, never the real `PROVIDER_CAPABILITY_REGISTRY`.
 */
describe("STAGE 3 — getPaymentWebhookService() lazy provider dependency", () => {
  const requiredEnv: Record<string, string> = {
    DATABASE_URL: "postgres://test:test@localhost:5432/pay2pay_test",
    AUDIT_HASH_SECRET: "test-only-audit-hash-secret-value",
    AUTH_PASSWORD_PEPPER: "test-only-auth-password-pepper-value",
    APP_ENV: "test",
    PAYMENT_SANDBOX_WEBHOOK_SECRET: "test-only-payment-sandbox-webhook-secret-value",
  };
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of Object.keys(requiredEnv)) {
      savedEnv[key] = process.env[key];
      process.env[key] = requiredEnv[key];
    }
    vi.resetModules();
    vi.doUnmock("@/lib/payments/getPaymentProvider");
  });

  afterEach(() => {
    for (const key of Object.keys(requiredEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.doUnmock("@/lib/payments/getPaymentProvider");
    vi.resetModules();
  });

  /** Mocks ONLY the `getPaymentProvider` module boundary to throw the SAME error class the real, unmodified `assertProviderAvailableForRuntime` throws today (registry is empty) — and counts every invocation. */
  function mockThrowingProviderBoundary() {
    let callCount = 0;
    vi.doMock("@/lib/payments/getPaymentProvider", () => ({
      getPaymentProvider: () => {
        callCount += 1;
        throw new ProviderNotAvailableError();
      },
    }));
    return { callCount: () => callCount };
  }

  it("G01 — a cold construction succeeds with the provider unavailable, resolves the provider ZERO times during construction, and exposes recoverBatch", async () => {
    const providerSpy = mockThrowingProviderBoundary();
    const { getPaymentWebhookService } = await import("./getPaymentWebhookService");

    const service = getPaymentWebhookService();

    expect(service).toBeDefined();
    expect(providerSpy.callCount()).toBe(0);
    expect(typeof service.recoverBatch).toBe("function");
    expect(typeof service.receiveInternalEvent).toBe("function");

    // Singleton caching still works once construction is allowed to complete — a second access
    // returns the SAME instance and still resolves the provider zero times.
    expect(getPaymentWebhookService()).toBe(service);
    expect(providerSpy.callCount()).toBe(0);
  });

  it("G05 — receiveWebhook on the real factory-constructed service rejects under the existing provider-unavailable contract, resolving the provider (not zero) only at actual invocation time, before any event claim/processing could occur", async () => {
    const providerSpy = mockThrowingProviderBoundary();
    const { getPaymentWebhookService } = await import("./getPaymentWebhookService");
    const service = getPaymentWebhookService();
    expect(providerSpy.callCount()).toBe(0); // construction itself still resolved nothing.

    // `receiveWebhook`'s own first statement (paymentWebhookService.ts:554) reads
    // `this.deps.provider.verifyWebhookSignature(...)` — the getter throws synchronously, before any
    // `await`, so no event-repository call, claim, or financial effect can occur first.
    await expect(service.receiveWebhook({ rawBody: "{}", signatureHeader: "sig" })).rejects.toBeInstanceOf(ProviderNotAvailableError);

    // The provider WAS genuinely resolved this time — proving invocation happens exactly at the
    // point of actual use, not merely "never called at all."
    expect(providerSpy.callCount()).toBeGreaterThanOrEqual(1);
  });
});
