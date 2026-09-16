import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION, requirement #9: proves the real production factory
 * wires `failClosed` correctly — production without a live Resend key must fail closed on an actual
 * send attempt, never silently succeed via ConsoleEmailSender. Mirrors getPaymentProvider.test.ts's
 * `vi.resetModules()` + dynamic-import pattern so both this module's own `cached` singleton and
 * src/config/env.ts's `cachedServerEnv` start fresh per test.
 */
describe("getEmailSender (PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION)", () => {
  const baseEnv: Record<string, string> = {
    DATABASE_URL: "postgres://test:test@localhost:5432/pay2pay_test",
    AUDIT_HASH_SECRET: "test-only-audit-hash-secret-value",
    AUTH_PASSWORD_PEPPER: "test-only-auth-password-pepper-value",
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
    delete process.env.APP_ENV;
    delete process.env.RESEND_API_KEY;
    vi.resetModules();
  });

  it("production without RESEND_API_KEY: getEmailSender() itself does not throw, but an actual send does (fails closed at send time, never silently succeeds)", async () => {
    setEnv({ APP_ENV: "production", APP_URL: "https://paid2you.com" });
    const { getEmailSender } = await import("./getEmailSender");
    const { EmailDeliveryError } = await import("./emailDeliveryError");
    const sender = getEmailSender();
    await expect(sender.send({ to: "user@example.com", subject: "Hi", body: "Body" })).rejects.toThrow(EmailDeliveryError);
  });

  it("development/test/staging without RESEND_API_KEY: send succeeds via console-only logging — unchanged, safe non-production default", async () => {
    for (const appEnv of ["development", "test", "staging"]) {
      vi.resetModules();
      setEnv({ APP_ENV: appEnv });
      const { getEmailSender } = await import("./getEmailSender");
      const sender = getEmailSender();
      const result = await sender.send({ to: "user@example.com", subject: "Hi", body: "Body" });
      expect(result.providerMessageId).toBeNull();
    }
  });

  it("production WITH a fully-configured live Resend key: getEmailSender() does not fail closed — real delivery is still possible once actually configured", async () => {
    setEnv({ APP_ENV: "production", RESEND_API_KEY: "re_live_key", EMAIL_FROM_ADDRESS: "notifications@paid2you.com", APP_URL: "https://paid2you.com" });
    const { getEmailSender } = await import("./getEmailSender");
    const { ResendEmailSender } = await import("./resendEmailSender");
    expect(getEmailSender()).toBeInstanceOf(ResendEmailSender);
  });
});
