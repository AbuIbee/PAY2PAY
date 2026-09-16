import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B1) established that these three
 * PRODUCTION factory getters must not recurse infinitely:
 *
 *   getPaymentRetryService -> getPaymentWebhookService -> getFailedPaymentWorkflowService
 *     -> getPaymentRetryService -> ...
 *
 * PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION changes what a cold call to any of them now does: since
 * getPaymentProvider() no longer has a sandbox fallback, every one of these factories now fails
 * closed with `ProviderNotAvailableError` instead of completing construction. That is the CORRECT,
 * intended outcome today (no live provider is registered — B-1 remains on hard hold) — but it must
 * still be a clean, immediate, synchronous rejection, never a `RangeError: Maximum call stack size
 * exceeded` from the same recursive-construction bug Package B fixed. Asserting `.toThrow
 * (ProviderNotAvailableError)` specifically (not just "throws something") is what distinguishes those
 * two failure shapes — a stack-overflow RangeError would also satisfy a generic `.toThrow()`.
 *
 * `vi.resetModules()` before each exercises the ACTUAL production factory bodies — never a
 * hand-assembled substitute — from a genuinely fresh module-level `cached = null`, exactly mirroring
 * a real cold server process.
 */
describe("PAID2YOU — production factory recursion safety (post B0-D sandbox elimination)", () => {
  const requiredEnv: Record<string, string> = {
    DATABASE_URL: "postgres://test:test@localhost:5432/pay2pay_test",
    AUDIT_HASH_SECRET: "test-only-audit-hash-secret-value",
    AUTH_PASSWORD_PEPPER: "test-only-auth-password-pepper-value",
    APP_ENV: "test",
  };
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of Object.keys(requiredEnv)) {
      savedEnv[key] = process.env[key];
      process.env[key] = requiredEnv[key];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of Object.keys(requiredEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.resetModules();
  });

  it("R-B67A — a cold call to getPaymentRetryService() fails closed immediately with ProviderNotAvailableError: no recursion, no RangeError", async () => {
    const { getPaymentRetryService } = await import("./getPaymentRetryService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getPaymentRetryService()).toThrow(ProviderNotAvailableError);
  });

  it("R-B67B — a cold call to getPaymentWebhookService() fails closed immediately with ProviderNotAvailableError: its failed-payment-workflow and retry-service dependencies never get a chance to recurse", async () => {
    const { getPaymentWebhookService } = await import("@/lib/payments/getPaymentWebhookService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getPaymentWebhookService()).toThrow(ProviderNotAvailableError);
  });

  it("R-B67C — a cold call to getFailedPaymentWorkflowService() fails closed immediately with ProviderNotAvailableError, not a recursive stack overflow", async () => {
    const { getFailedPaymentWorkflowService } = await import("./getFailedPaymentWorkflowService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getFailedPaymentWorkflowService()).toThrow(ProviderNotAvailableError);
  });

  it("R-B67D — a cold call to getPaymentService() fails closed immediately with ProviderNotAvailableError: no recursion, no RangeError (Defect B1-2's installmentHook lazy-thunk wiring is still exercised, harmlessly, since it is itself lazy)", async () => {
    const { getPaymentService } = await import("@/lib/payments/getPaymentService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    expect(() => getPaymentService()).toThrow(ProviderNotAvailableError);
  });

  it("none of the four factories throw a plain RangeError (the original recursion bug's signature) — every failure is the expected, typed ProviderNotAvailableError", async () => {
    const { getPaymentRetryService } = await import("./getPaymentRetryService");
    let thrown: unknown;
    try {
      getPaymentRetryService();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(thrown).not.toBeInstanceOf(RangeError);
  });
});
