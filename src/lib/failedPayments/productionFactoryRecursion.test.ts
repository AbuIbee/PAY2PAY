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
 * fix's own doc comment in `getPaymentRetryService.ts`. `getPaymentService.ts`'s own `installmentHook`
 * property is the identical pattern, closing a second, later-introduced cycle (Defect B1-2):
 * `getPaymentService -> getFailedPaymentWorkflowService -> getPaymentRetryService ->
 * getAchPaymentService`/`getDebitCardPaymentService` -> `getPaymentService`.
 *
 * REM-013 correction: the previous version of this file asserted `.not.toThrow()`, then (after SC-01
 * total sandbox elimination made a cold `getPaymentProvider()` call always throw
 * `ProviderNotAvailableError`, since `PROVIDER_CAPABILITY_REGISTRY` is empty) was changed to assert
 * that specific throw instead. Both versions are INSUFFICIENT: `getPaymentProvider()` is called EARLY
 * in every one of these four factories' own construction (the very first property in
 * `getPaymentWebhookService`/`getPaymentService`, the fourth in `getPaymentRetryService`) — well BEFORE
 * the lazy-thunk edges the original recursion bug is actually about are ever reached. A test that
 * throws at `getPaymentProvider()` proves nothing about whether `effectApplier`/`installmentHook` are
 * still lazy; it would pass identically whether those thunks are correctly deferred OR had regressed
 * back to an eager call, because construction never gets that far either way.
 *
 * This version mocks ONLY the `getPaymentProvider` module boundary (via `vi.doMock`, scoped to this
 * test file, reset every test) so a cold factory call proceeds PAST provider construction and all the
 * way through the real lazy-thunk edges — never registering anything in the real
 * `PROVIDER_CAPABILITY_REGISTRY`, never touching runtime provider availability, and never replacing
 * any of the four factories under test themselves, whose own real construction bodies run unmodified.
 * The OTHER three factory modules (`getPaymentWebhookService`, `getFailedPaymentWorkflowService`,
 * `getPaymentRetryService`) are each wrapped — via `vi.importActual` composed with a call counter, so
 * their REAL implementation still runs — with a spy that proves whether the lazy edge under test was
 * actually invoked DURING construction (must be zero) versus only later, at genuine invocation time.
 * A test that only checked "did it throw" cannot distinguish correct lazy construction from a
 * regressed eager one; a call-count assertion on the exact edge the original bug was about can.
 */
describe("PAID2YOU — PACKAGE B (Codex final remaining blockers, Section B1): production factory recursion", () => {
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
    vi.doUnmock("@/lib/payments/getPaymentWebhookService");
    vi.doUnmock("@/lib/failedPayments/getFailedPaymentWorkflowService");
    vi.doUnmock("@/lib/failedPayments/getPaymentRetryService");
  });

  afterEach(() => {
    for (const key of Object.keys(requiredEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.doUnmock("@/lib/payments/getPaymentProvider");
    vi.doUnmock("@/lib/payments/getPaymentWebhookService");
    vi.doUnmock("@/lib/failedPayments/getFailedPaymentWorkflowService");
    vi.doUnmock("@/lib/failedPayments/getPaymentRetryService");
    vi.resetModules();
  });

  /**
   * Mocks ONLY the `getPaymentProvider` MODULE boundary — never the production
   * `PROVIDER_CAPABILITY_REGISTRY`, never any runtime provider-availability state — so every one of
   * the four factories under test can complete real construction past the point where a cold
   * `getPaymentProvider()` call would otherwise throw `ProviderNotAvailableError`. Returns an inert
   * double: no method on it is expected to be CALLED during construction (only stored as a
   * dependency), so any accidental invocation during a future refactor fails loudly instead of
   * silently succeeding.
   */
  function mockProviderBoundary() {
    vi.doMock("@/lib/payments/getPaymentProvider", () => ({
      getPaymentProvider: () => ({
        providerName: "inert_construction_only_double",
        providerEnvironment: "production",
        createPayment: () => {
          throw new Error("inert double: createPayment must never be called merely by constructing a factory");
        },
        retrievePayment: () => {
          throw new Error("inert double: retrievePayment must never be called merely by constructing a factory");
        },
      }),
    }));
  }

  /** Wraps the REAL `getPaymentWebhookService` export with an external call counter (`vi.importActual`, so the true implementation still runs) — the counter is what proves the `effectApplier`/`installmentHook` lazy thunks were never invoked during unrelated construction. */
  async function spyOnRealWebhookServiceFactory() {
    let callCount = 0;
    vi.doMock("@/lib/payments/getPaymentWebhookService", async () => {
      const actual = await vi.importActual<typeof import("@/lib/payments/getPaymentWebhookService")>("@/lib/payments/getPaymentWebhookService");
      return {
        ...actual,
        getPaymentWebhookService: (...args: Parameters<typeof actual.getPaymentWebhookService>) => {
          callCount += 1;
          return actual.getPaymentWebhookService(...args);
        },
      };
    });
    return { callCount: () => callCount };
  }

  /** Identical pattern for `getFailedPaymentWorkflowService` — the edge `getPaymentService.ts`'s `installmentHook` defers. */
  async function spyOnRealFailedPaymentWorkflowServiceFactory() {
    let callCount = 0;
    vi.doMock("@/lib/failedPayments/getFailedPaymentWorkflowService", async () => {
      const actual = await vi.importActual<typeof import("@/lib/failedPayments/getFailedPaymentWorkflowService")>(
        "@/lib/failedPayments/getFailedPaymentWorkflowService",
      );
      return {
        ...actual,
        getFailedPaymentWorkflowService: (...args: Parameters<typeof actual.getFailedPaymentWorkflowService>) => {
          callCount += 1;
          return actual.getFailedPaymentWorkflowService(...args);
        },
      };
    });
    return { callCount: () => callCount };
  }

  it("TEST 013-A — a cold call to getPaymentRetryService() succeeds past provider construction, and its effectApplier NEVER invokes getPaymentWebhookService() during that construction (the original lazy-thunk fix, proven by a zero call count — not merely by the absence of a throw)", async () => {
    mockProviderBoundary();
    const webhookSpy = await spyOnRealWebhookServiceFactory();
    const { getPaymentRetryService } = await import("./getPaymentRetryService");

    const service = getPaymentRetryService();

    expect(service).toBeDefined();
    // The decisive assertion: if `effectApplier` regressed back to an EAGER
    // `getPaymentWebhookService()` call (the original Codex-found bug), this would be >= 1 (or the
    // whole test would have already failed with a RangeError before reaching this line at all).
    expect(webhookSpy.callCount()).toBe(0);
    // A second cold construction still returns the SAME cached instance — the singleton itself
    // works correctly once real construction is allowed to complete.
    expect(getPaymentRetryService()).toBe(service);
    expect(webhookSpy.callCount()).toBe(0);
  });

  it("TEST 013-B — a cold call to getPaymentWebhookService() succeeds all the way through its eager failedPaymentWorkflow dependency (which itself eagerly constructs getPaymentRetryService), with getPaymentWebhookService never re-entered during its own construction, and getPaymentRetryService's own effectApplier edge still never firing", async () => {
    mockProviderBoundary();
    const webhookSpy = await spyOnRealWebhookServiceFactory();
    const { getPaymentWebhookService } = await import("@/lib/payments/getPaymentWebhookService");

    const service = getPaymentWebhookService();

    expect(service).toBeDefined();
    // Exactly one call — the outer one this test itself made. A regression that made
    // `getFailedPaymentWorkflowService -> getPaymentRetryService`'s own effectApplier eager again
    // would re-enter `getPaymentWebhookService()` a SECOND time, deep inside this same construction,
    // making this 2 (or overflow the stack before ever getting here).
    expect(webhookSpy.callCount()).toBe(1);
    // A second OUTER call still increments the wrapper's own call count to 2 (it counts invocations
    // of the exported function itself, not internal reconstructions) — but returns the SAME cached
    // instance, proving the module-level singleton still works correctly once real construction is
    // allowed to complete.
    expect(getPaymentWebhookService()).toBe(service);
    expect(webhookSpy.callCount()).toBe(2);
  });

  it("TEST 013-C — a cold call to getFailedPaymentWorkflowService() constructs its entire dependency graph (including getPaymentRetryService, eagerly, as its own `retries` property) without recursion — the SAME effectApplier edge inside that nested getPaymentRetryService construction never fires either", async () => {
    mockProviderBoundary();
    const webhookSpy = await spyOnRealWebhookServiceFactory();
    const { getFailedPaymentWorkflowService } = await import("./getFailedPaymentWorkflowService");

    const service = getFailedPaymentWorkflowService();

    expect(service).toBeDefined();
    // getFailedPaymentWorkflowService itself never calls getPaymentWebhookService at all (only
    // getPaymentRetryService's effectApplier, lazily, would) — so this stays at zero.
    expect(webhookSpy.callCount()).toBe(0);
    expect(getFailedPaymentWorkflowService()).toBe(service);
  });

  it("TEST 013-D — a cold call to getPaymentService() succeeds, and its installmentHook NEVER invokes getFailedPaymentWorkflowService() during construction (Defect B1-2's own lazy-thunk fix, proven by a zero call count)", async () => {
    mockProviderBoundary();
    const workflowSpy = await spyOnRealFailedPaymentWorkflowServiceFactory();
    const { getPaymentService } = await import("@/lib/payments/getPaymentService");

    const service = getPaymentService();

    expect(service).toBeDefined();
    // The decisive assertion for Defect B1-2: if `installmentHook` regressed back to an EAGER
    // `getFailedPaymentWorkflowService()` call, this would be >= 1.
    expect(workflowSpy.callCount()).toBe(0);
    expect(getPaymentService()).toBe(service);
    expect(workflowSpy.callCount()).toBe(0);
  });

  it("spy sanity check: the call-count wrapper genuinely increments on a real invocation (TEST 013-B's own callCount() === 1 assertion already demonstrates this for getPaymentWebhookService — this test demonstrates it independently for getFailedPaymentWorkflowService, so neither spy's zero-count assertions above are vacuously true)", async () => {
    mockProviderBoundary();
    const workflowSpy = await spyOnRealFailedPaymentWorkflowServiceFactory();
    const { getFailedPaymentWorkflowService } = await import("@/lib/failedPayments/getFailedPaymentWorkflowService");
    expect(workflowSpy.callCount()).toBe(0);
    getFailedPaymentWorkflowService();
    expect(workflowSpy.callCount()).toBe(1);
  });
});
