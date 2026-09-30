import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderNotAvailableError } from "@/lib/errors";

/**
 * STAGE 3 G02/G06 (docs/remediation/STAGE_03_G01_G12_EXECUTION_AND_ACCEPTANCE_REPORT.md): the real
 * production `getPaymentRetryService()` factory must construct successfully even when no live
 * payment provider is registered. `PaymentRetryService.deps.provider` was already optional and was
 * already only validated lazily inside `fireDueRetries` (paymentRetryService.ts's own
 * `if (!this.deps.provider) throw ...` guard, evaluated before any database call in that method) —
 * `findForOriginalPayment` never touches it at all. The only defect was the FACTORY eagerly resolving
 * `getPaymentProvider()` as a constructor argument, defeating that already-correct lazy service
 * design. Mirrors `productionFactoryRecursion.test.ts`'s own module-reset/env conventions; mocks
 * ONLY the `getPaymentProvider` module boundary, never the real `PROVIDER_CAPABILITY_REGISTRY`.
 */
describe("STAGE 3 — getPaymentRetryService() lazy provider dependency", () => {
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

  it("G02 — a cold construction succeeds with the provider unavailable, resolves the provider ZERO times during construction, and exposes findForOriginalPayment", async () => {
    const providerSpy = mockThrowingProviderBoundary();
    const { getPaymentRetryService } = await import("./getPaymentRetryService");

    const service = getPaymentRetryService();

    expect(service).toBeDefined();
    expect(providerSpy.callCount()).toBe(0);
    expect(typeof service.findForOriginalPayment).toBe("function");
    expect(typeof service.fireDueRetries).toBe("function");

    // Singleton caching still works once construction is allowed to complete, and no recursive
    // factory construction occurs (productionFactoryRecursion.test.ts's own concern) — a second
    // access returns the SAME instance and still resolves the provider zero times.
    expect(getPaymentRetryService()).toBe(service);
    expect(providerSpy.callCount()).toBe(0);
  });

  it("G06 — fireDueRetries on the real factory-constructed service still fails closed when the provider is unavailable, before any due-retry lookup or dispatch is attempted", async () => {
    const providerSpy = mockThrowingProviderBoundary();
    const { getPaymentRetryService } = await import("./getPaymentRetryService");
    const service = getPaymentRetryService();
    expect(providerSpy.callCount()).toBe(0); // construction itself still resolved nothing.

    // `fireDueRetries`'s own existing `if (!this.deps.provider) throw ...` guard
    // (paymentRetryService.ts:397) is evaluated before `findDueForFiring`'s own first database call
    // — so this guard being reachable at all (rather than the whole service failing to construct) is
    // exactly the fix; it must still reject rather than silently proceeding to dispatch anything.
    await expect(service.fireDueRetries()).rejects.toThrow();

    // The provider WAS genuinely resolved this time — proving invocation happens exactly at the
    // point of actual use, not merely "never called at all."
    expect(providerSpy.callCount()).toBeGreaterThanOrEqual(1);
  });
});
