import "server-only";
import { getServerEnv, type ServerEnv } from "@/config/env";

/**
 * PRSprint 04 (docs/prsprints/PRSPRINT_04_SECRETS_ENVIRONMENT_PRODUCTION_SEPARATION.md): an
 * admin-only, secret-free view of which providers are configured and what mode each one runs in.
 * Every field is a boolean-like enum derived from *whether a var is set*, never the var's value —
 * this module must never return, log, or expose an actual secret. It also must never claim a
 * capability is "live" that this codebase cannot actually reach: `getPaymentProvider()` and
 * `getKycProvider()` are unconditionally wired to their sandbox implementations (no live adapter
 * exists in this codebase yet — that is PRSprint 21's scope) — so `paymentProvider`/`kycProvider`
 * below stay fixed labels reflecting that reality by construction. `emailDelivery` (PRSprint 14) and
 * `smsDelivery` (PRSprint 15) are both genuinely conditional, each mirroring exactly the same decision
 * its own `get*Sender()` factory makes at send time — this view can never drift from what the code
 * actually does because it reads the identical inputs.
 */
export type ProviderConfigStatus = "configured" | "not_configured";
export type EmailDeliveryStatus = "resend" | "console_log_only_no_provider" | "console_log_only_kill_switch";
export type SmsDeliveryStatus = "twilio" | "console_log_only_no_provider" | "console_log_only_kill_switch";

export interface AdminEnvironmentStatus {
  appEnv: string;
  nodeEnv: string;
  database: ProviderConfigStatus;
  documentStorage: ProviderConfigStatus;
  paymentProvider: "sandbox";
  kycProvider: "sandbox";
  emailDelivery: EmailDeliveryStatus;
  smsDelivery: SmsDeliveryStatus;
  scheduledJobs: ProviderConfigStatus;
}

function computeEmailDeliveryStatus(env: ServerEnv): EmailDeliveryStatus {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM_ADDRESS) return "console_log_only_no_provider";
  if (!env.EMAIL_DELIVERY_ENABLED) return "console_log_only_kill_switch";
  return "resend";
}

function computeSmsDeliveryStatus(env: ServerEnv): SmsDeliveryStatus {
  const hasSender = Boolean(env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER);
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !hasSender) return "console_log_only_no_provider";
  if (!env.SMS_DELIVERY_ENABLED) return "console_log_only_kill_switch";
  return "twilio";
}

/** Pure classification function — kept separate from the process.env-reading singleton below so it can be unit-tested with constructed ServerEnv values, mirroring parseServerEnv/getServerEnv's own split in src/config/env.ts. */
export function computeEnvironmentStatus(env: ServerEnv): AdminEnvironmentStatus {
  return {
    appEnv: env.APP_ENV,
    nodeEnv: env.NODE_ENV,
    database: env.DATABASE_URL ? "configured" : "not_configured",
    documentStorage: env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? "configured" : "not_configured",
    paymentProvider: "sandbox",
    kycProvider: "sandbox",
    emailDelivery: computeEmailDeliveryStatus(env),
    smsDelivery: computeSmsDeliveryStatus(env),
    scheduledJobs: env.CRON_SECRET ? "configured" : "not_configured",
  };
}

export interface EnvironmentStatusReader {
  getStatus(): AdminEnvironmentStatus;
}

/** Real implementation: reads the validated server environment singleton. Never exposes a secret value — see this file's module doc comment. */
export class RealEnvironmentStatusReader implements EnvironmentStatusReader {
  getStatus(): AdminEnvironmentStatus {
    return computeEnvironmentStatus(getServerEnv());
  }
}
