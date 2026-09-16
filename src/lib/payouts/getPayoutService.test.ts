import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAID2YOU — B0-D PHASE 3B (payout integrity). Proves the real production factory — never a
 * hand-assembled substitute — wires `PAYOUT_PROVIDER_INTEGRATION_VERIFIED` into `PayoutService`
 * correctly, and that (unlike `getBankConnectionService()`'s identical-looking
 * `ADYEN_ACH_TOKENIZATION_VERIFIED` gate) construction itself is never gated — only `confirmPayout` is,
 * so `recordPayoutOwed`/`failPayout` keep working with no live provider configured at all. Mirrors
 * `getBankConnectionService.test.ts`'s `vi.resetModules()` pattern so both this module's own `cached`
 * singleton and `src/config/env.ts`'s `cachedServerEnv` start fresh, like a real cold server process.
 *
 * Deliberately never exercises a real database — no live Postgres exists in this environment (see
 * `docs/PROGRESS.md`'s established convention). `confirmPayout`'s integration-flag check runs BEFORE
 * any repository access, so the "gated" assertions below resolve without ever touching `getDb()`.
 */
describe("getPayoutService (PAID2YOU — B0-D PHASE 3B)", () => {
  let savedEnv: Record<string, string | undefined> = {};

  function setEnv(overrides: Record<string, string | undefined>) {
    for (const [key, value] of Object.entries(overrides)) {
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
    delete process.env.PAYOUT_PROVIDER_INTEGRATION_VERIFIED;
    vi.resetModules();
  });

  it("construction itself is never gated — unlike getBankConnectionService, getPayoutService() returns a real instance with PAYOUT_PROVIDER_INTEGRATION_VERIFIED unset", async () => {
    setEnv({});
    const { getPayoutService } = await import("./getPayoutService");
    const { PayoutService } = await import("./payoutService");
    expect(getPayoutService()).toBeInstanceOf(PayoutService);
  });

  it("is memoized (same instance) across calls, matching every other get*Service factory in this codebase", async () => {
    setEnv({});
    const { getPayoutService } = await import("./getPayoutService");
    expect(getPayoutService()).toBe(getPayoutService());
  });

  it("confirmPayout fails closed with ProviderNotAvailableError, before ever touching the database, when PAYOUT_PROVIDER_INTEGRATION_VERIFIED is unset", async () => {
    setEnv({});
    const { getPayoutService } = await import("./getPayoutService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    await expect(
      getPayoutService().confirmPayout({ paymentAttemptId: "00000000-0000-0000-0000-000000000000", providerName: "adyen", providerPayoutReference: "ref-1" }),
    ).rejects.toThrow(ProviderNotAvailableError);
  });

  it("confirmPayout fails closed the same way when explicitly PAYOUT_PROVIDER_INTEGRATION_VERIFIED=false", async () => {
    setEnv({ PAYOUT_PROVIDER_INTEGRATION_VERIFIED: "false" });
    const { getPayoutService } = await import("./getPayoutService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    await expect(
      getPayoutService().confirmPayout({ paymentAttemptId: "00000000-0000-0000-0000-000000000000", providerName: "adyen", providerPayoutReference: "ref-1" }),
    ).rejects.toThrow(ProviderNotAvailableError);
  });

  it("never assumes approval from APP_ENV alone — production with no explicit verification flag still fails closed", async () => {
    setEnv({ APP_ENV: "production", APP_URL: "https://paid2you.com" });
    const { getPayoutService } = await import("./getPayoutService");
    const { ProviderNotAvailableError } = await import("@/lib/errors");
    await expect(
      getPayoutService().confirmPayout({ paymentAttemptId: "00000000-0000-0000-0000-000000000000", providerName: "adyen", providerPayoutReference: "ref-1" }),
    ).rejects.toThrow(ProviderNotAvailableError);
  });
});
