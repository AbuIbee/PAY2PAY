import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION, requirement #9 — mirrors getEmailSender.test.ts's identical pattern and rationale. */
describe("getSmsSender (PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION)", () => {
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
    delete process.env.TWILIO_ACCOUNT_SID;
    vi.resetModules();
  });

  it("production without Twilio credentials: getSmsSender() itself does not throw, but an actual send does (fails closed at send time, never silently succeeds)", async () => {
    setEnv({ APP_ENV: "production", APP_URL: "https://paid2you.com" });
    const { getSmsSender } = await import("./getSmsSender");
    const { SmsDeliveryError } = await import("./smsDeliveryError");
    const sender = getSmsSender();
    await expect(sender.send({ to: "+15005550006", body: "Hi" })).rejects.toThrow(SmsDeliveryError);
  });

  it("development/test/staging without Twilio credentials: send succeeds via console-only logging — unchanged, safe non-production default", async () => {
    for (const appEnv of ["development", "test", "staging"]) {
      vi.resetModules();
      setEnv({ APP_ENV: appEnv });
      const { getSmsSender } = await import("./getSmsSender");
      const sender = getSmsSender();
      const result = await sender.send({ to: "+15005550006", body: "Hi" });
      expect(result.providerMessageId).toBeNull();
    }
  });

  it("production WITH fully-configured live Twilio credentials: getSmsSender() does not fail closed", async () => {
    setEnv({
      APP_ENV: "production",
      TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32),
      TWILIO_AUTH_TOKEN: "t".repeat(32),
      TWILIO_FROM_NUMBER: "+15005550006",
      APP_URL: "https://paid2you.com",
    });
    const { getSmsSender } = await import("./getSmsSender");
    const { TwilioSmsSender } = await import("./twilioSmsSender");
    expect(getSmsSender()).toBeInstanceOf(TwilioSmsSender);
  });
});
