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
    PAYMENT_PROVIDER: undefined,
    KYC_PROVIDER: undefined,
    CARD_ISSUING_PROVIDER: undefined,
    CRON_SECRET: undefined,
    RESEND_API_KEY: undefined,
    EMAIL_FROM_ADDRESS: undefined,
    EMAIL_FROM_NAME: "PAY2PAY",
    RESEND_WEBHOOK_SECRET: undefined,
    EMAIL_DELIVERY_ENABLED: true,
    TWILIO_ACCOUNT_SID: undefined,
    TWILIO_AUTH_TOKEN: undefined,
    TWILIO_MESSAGING_SERVICE_SID: undefined,
    TWILIO_FROM_NUMBER: undefined,
    SMS_DELIVERY_ENABLED: true,
    ADYEN_ACH_TOKENIZATION_VERIFIED: false,
    PAYOUT_PROVIDER_INTEGRATION_VERIFIED: false,
    ADYEN_PAYMENTS_VERIFIED: false,
    ...overrides,
  };
}

describe("computeEnvironmentStatus", () => {
  it("never includes an actual secret value — every field is a boolean-like label", () => {
    const status = computeEnvironmentStatus(
      baseEnv({
        SUPABASE_URL: "https://proj.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "a-real-looking-secret-value",
        CRON_SECRET: "another-real-looking-secret",
      }),
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

  it(
    "PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION: always reports payment/KYC/card-issuing providers as " +
      "'unavailable', regardless of APP_ENV — the capability registry is empty until a live provider " +
      "is approved, so nothing can ever resolve, and there is no sandbox label left to fall back to",
    () => {
      for (const appEnv of ["development", "test", "staging", "production"] as const) {
        const status = computeEnvironmentStatus(baseEnv({ APP_ENV: appEnv }));
        expect(status.paymentProvider).toBeNull();
        expect(status.paymentProviderEnvironment).toBe("unavailable");
        expect(status.kycProvider).toBeNull();
        expect(status.kycProviderEnvironment).toBe("unavailable");
        expect(status.cardIssuingProvider).toBeNull();
        expect(status.cardIssuingProviderEnvironment).toBe("unavailable");
      }
    },
  );

  it("reports 'unavailable' even when PAYMENT_PROVIDER/KYC_PROVIDER/CARD_ISSUING_PROVIDER are explicitly set to a real-looking name — the registry is empty, so nothing registered can resolve until a real provider is added there", () => {
    const status = computeEnvironmentStatus(
      baseEnv({ PAYMENT_PROVIDER: "acme_payments_live", KYC_PROVIDER: "acme_kyc_live", CARD_ISSUING_PROVIDER: "acme_cards_live" }),
    );
    expect(status.paymentProvider).toBe("acme_payments_live");
    expect(status.paymentProviderEnvironment).toBe("unavailable");
    expect(status.kycProvider).toBe("acme_kyc_live");
    expect(status.kycProviderEnvironment).toBe("unavailable");
    expect(status.cardIssuingProvider).toBe("acme_cards_live");
    expect(status.cardIssuingProviderEnvironment).toBe("unavailable");
  });

  it("reports smsDelivery as console_log_only_no_provider when Twilio isn't fully configured", () => {
    expect(computeEnvironmentStatus(baseEnv()).smsDelivery).toBe("console_log_only_no_provider");
    expect(computeEnvironmentStatus(baseEnv({ TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32) })).smsDelivery).toBe("console_log_only_no_provider");
    expect(computeEnvironmentStatus(baseEnv({ TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32), TWILIO_AUTH_TOKEN: "t".repeat(32) })).smsDelivery).toBe(
      "console_log_only_no_provider",
    ); // no sender (messaging service or from-number) configured
  });

  it("reports smsDelivery as twilio once account credentials and a sender are configured and the kill switch is on", () => {
    const status = computeEnvironmentStatus(
      baseEnv({ TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32), TWILIO_AUTH_TOKEN: "t".repeat(32), TWILIO_FROM_NUMBER: "+15005550006" }),
    );
    expect(status.smsDelivery).toBe("twilio");
  });

  it("reports smsDelivery as twilio when a messaging service SID is configured instead of a from-number", () => {
    const status = computeEnvironmentStatus(
      baseEnv({ TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32), TWILIO_AUTH_TOKEN: "t".repeat(32), TWILIO_MESSAGING_SERVICE_SID: "MG" + "x".repeat(32) }),
    );
    expect(status.smsDelivery).toBe("twilio");
  });

  it("reports smsDelivery as console_log_only_kill_switch when fully configured but the kill switch is off", () => {
    const status = computeEnvironmentStatus(
      baseEnv({ TWILIO_ACCOUNT_SID: "AC" + "x".repeat(32), TWILIO_AUTH_TOKEN: "t".repeat(32), TWILIO_FROM_NUMBER: "+15005550006", SMS_DELIVERY_ENABLED: false }),
    );
    expect(status.smsDelivery).toBe("console_log_only_kill_switch");
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
