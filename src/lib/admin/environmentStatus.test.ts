import { describe, expect, it } from "vitest";
import type { ServerEnv } from "@/config/env";
import { computeEnvironmentStatus } from "./environmentStatus";

function baseEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    NODE_ENV: "production",
    APP_ENV: "production",
    DATABASE_URL: "postgres://user:pass@host:5432/db",
    AUDIT_HASH_SECRET: "a".repeat(16),
    AUTH_PASSWORD_PEPPER: "b".repeat(16),
    APP_URL: "https://example.com",
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    PAYMENT_SANDBOX_WEBHOOK_SECRET: undefined,
    KYC_SANDBOX_WEBHOOK_SECRET: undefined,
    CRON_SECRET: undefined,
    RESEND_API_KEY: undefined,
    EMAIL_FROM_ADDRESS: undefined,
    EMAIL_FROM_NAME: "PAY2PAY",
    RESEND_WEBHOOK_SECRET: undefined,
    EMAIL_DELIVERY_ENABLED: true,
    ...overrides,
  };
}

describe("computeEnvironmentStatus", () => {
  it("never includes an actual secret value — every field is a boolean-like label", () => {
    const status = computeEnvironmentStatus(
      baseEnv({ SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "a-real-looking-secret-value", CRON_SECRET: "another-real-looking-secret" }),
    );
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("a-real-looking-secret-value");
    expect(serialized).not.toContain("another-real-looking-secret");
  });

  it("reports database as not_configured when DATABASE_URL is empty", () => {
    const status = computeEnvironmentStatus(baseEnv({ DATABASE_URL: "" }));
    expect(status.database).toBe("not_configured");
  });

  it("reports database as configured when DATABASE_URL is set", () => {
    const status = computeEnvironmentStatus(baseEnv());
    expect(status.database).toBe("configured");
  });

  it("reports document storage as not_configured unless both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set", () => {
    expect(computeEnvironmentStatus(baseEnv({ SUPABASE_URL: "https://proj.supabase.co" })).documentStorage).toBe("not_configured");
    expect(computeEnvironmentStatus(baseEnv({ SUPABASE_SERVICE_ROLE_KEY: "x".repeat(20) })).documentStorage).toBe("not_configured");
    expect(
      computeEnvironmentStatus(baseEnv({ SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(20) })).documentStorage,
    ).toBe("configured");
  });

  it("reports scheduled jobs as configured only when CRON_SECRET is set", () => {
    expect(computeEnvironmentStatus(baseEnv()).scheduledJobs).toBe("not_configured");
    expect(computeEnvironmentStatus(baseEnv({ CRON_SECRET: "c".repeat(20) })).scheduledJobs).toBe("configured");
  });

  it("always reports payment/KYC providers as sandbox and SMS as console_log_only, regardless of APP_ENV — this codebase has no live adapter for either of them yet", () => {
    for (const appEnv of ["development", "test", "staging", "production"] as const) {
      const status = computeEnvironmentStatus(baseEnv({ APP_ENV: appEnv }));
      expect(status.paymentProvider).toBe("sandbox");
      expect(status.kycProvider).toBe("sandbox");
      expect(status.smsDelivery).toBe("console_log_only");
    }
  });

  it("reports emailDelivery as console_log_only_no_provider when no Resend key/from-address is configured", () => {
    expect(computeEnvironmentStatus(baseEnv()).emailDelivery).toBe("console_log_only_no_provider");
    expect(computeEnvironmentStatus(baseEnv({ RESEND_API_KEY: "re_test_key" })).emailDelivery).toBe("console_log_only_no_provider");
    expect(computeEnvironmentStatus(baseEnv({ EMAIL_FROM_ADDRESS: "notifications@paid2you.com" })).emailDelivery).toBe("console_log_only_no_provider");
  });

  it("reports emailDelivery as resend once both a key and a from-address are configured and the kill switch is on", () => {
    const status = computeEnvironmentStatus(baseEnv({ RESEND_API_KEY: "re_test_key", EMAIL_FROM_ADDRESS: "notifications@paid2you.com" }));
    expect(status.emailDelivery).toBe("resend");
  });

  it("reports emailDelivery as console_log_only_kill_switch when fully configured but the kill switch is off", () => {
    const status = computeEnvironmentStatus(
      baseEnv({ RESEND_API_KEY: "re_test_key", EMAIL_FROM_ADDRESS: "notifications@paid2you.com", EMAIL_DELIVERY_ENABLED: false }),
    );
    expect(status.emailDelivery).toBe("console_log_only_kill_switch");
  });

  it("passes through appEnv and nodeEnv verbatim", () => {
    const status = computeEnvironmentStatus(baseEnv({ APP_ENV: "staging", NODE_ENV: "production" }));
    expect(status.appEnv).toBe("staging");
    expect(status.nodeEnv).toBe("production");
  });
});
