import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B1 — CRITICAL release blocker).
 * Codex independently proved a real infinite-recursion cycle across these three PRODUCTION factory
 * getters:
 *
 *   getPaymentRetryService -> getPaymentWebhookService -> getFailedPaymentWorkflowService
 *     -> getPaymentRetryService -> ...
 *
 * (RangeError: Maximum call stack size exceeded) — caused by `getPaymentRetryService.ts` eagerly
 * invoking `getPaymentWebhookService()` as a constructor ARGUMENT, evaluated BEFORE that module's own
 * `cached` singleton is ever assigned. Fixed by wrapping that one dependency edge in a lazy object
 * whose `receiveInternalEvent` method only calls `getPaymentWebhookService()` at actual invocation
 * time (long after every getter involved has already run to completion at least once) — see that
 * fix's own doc comment in `getPaymentRetryService.ts`.
 *
 * These tests exercise the ACTUAL production factory bodies — never a hand-assembled substitute —
 * with `vi.resetModules()` before each so every cold-call scenario starts from a genuinely fresh
 * module-level `cached = null`, exactly mirroring a real fresh server process. Only genuinely
 * external/runtime configuration (env vars a real deployment would also need) is stubbed; nothing
 * about the three factories under test, or any of their real dependencies, is replaced.
 */
describe("PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B1): production factory recursion", () => {
  const requiredEnv: Record<string, string> = {
    DATABASE_URL: "postgres://test:test@localhost:5432/pay2pay_test",
    AUDIT_HASH_SECRET: "test-only-audit-hash-secret-value",
    AUTH_PASSWORD_PEPPER: "test-only-auth-password-pepper-value",
    APP_ENV: "test",
    // Optional at the schema level (getPaymentProvider() throws a ConfigurationError without it) —
    // every real deployment provisions this; a cold factory call genuinely needs it configured.
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
  });

  afterEach(() => {
    for (const key of Object.keys(requiredEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.resetModules();
  });

  it("R-B67A — a cold call to getPaymentRetryService() returns normally: no recursion, no RangeError", async () => {
    const { getPaymentRetryService } = await import("./getPaymentRetryService");
    let service: unknown;
    expect(() => {
      service = getPaymentRetryService();
    }).not.toThrow();
    expect(service).toBeDefined();
    // Calling it again returns the SAME cached instance — the singleton itself still works correctly.
    expect(getPaymentRetryService()).toBe(service);
  });

  it("R-B67B — a cold call to getPaymentWebhookService() returns normally; its failed-payment-workflow and retry-service dependencies resolve with no recursive construction", async () => {
    const { getPaymentWebhookService } = await import("@/lib/payments/getPaymentWebhookService");
    let service: unknown;
    expect(() => {
      service = getPaymentWebhookService();
    }).not.toThrow();
    expect(service).toBeDefined();
    expect(getPaymentWebhookService()).toBe(service);
  });

  it("R-B67C — a cold call to getFailedPaymentWorkflowService() constructs its entire dependency graph normally", async () => {
    const { getFailedPaymentWorkflowService } = await import("./getFailedPaymentWorkflowService");
    let service: unknown;
    expect(() => {
      service = getFailedPaymentWorkflowService();
    }).not.toThrow();
    expect(service).toBeDefined();
    expect(getFailedPaymentWorkflowService()).toBe(service);
  });
});
