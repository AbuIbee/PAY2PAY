import "server-only";
import { getServerEnv, type ServerEnv } from "@/config/env";
import { findProviderCapabilityDescriptor, type ProviderEnvironment } from "@/lib/providers/providerCapabilities";

/**
 * PRSprint 04 (docs/prsprints/PRSPRINT_04_SECRETS_ENVIRONMENT_PRODUCTION_SEPARATION.md): an
 * admin-only, secret-free view of which providers are configured and what mode each one runs in.
 * Every field is a boolean-like enum derived from *whether a var is set*, never the var's value —
 * this module must never return, log, or expose an actual secret. It also must never claim a
 * capability is "live" that this codebase cannot actually reach.
 *
 * PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION: `paymentProvider`/`kycProvider` used to always resolve
 * to a hardcoded sandbox descriptor (PRSprint 21's own state at the time). They now read whatever
 * PAYMENT_PROVIDER/KYC_PROVIDER/CARD_ISSUING_PROVIDER is actually configured and look it up in the
 * SAME capability registry the real provider factories consult
 * (src/lib/providers/providerCapabilities.ts) — which is empty until a live provider is approved. So
 * today, in every environment, this correctly reports "unavailable" rather than a sandbox label that
 * no longer exists anywhere in this codebase's runtime.
 */
export type ProviderConfigStatus = "configured" | "not_configured";
export type ProviderRuntimeStatus = "unavailable" | ProviderEnvironment;
export type EmailDeliveryStatus = "resend" | "console_log_only_no_provider" | "console_log_only_kill_switch";
export type SmsDeliveryStatus = "twilio" | "console_log_only_no_provider" | "console_log_only_kill_switch";

export interface AdminEnvironmentStatus {
  appEnv: string;
  nodeEnv: string;
  database: ProviderConfigStatus;
  documentStorage: ProviderConfigStatus;
  paymentProvider: string | null;
  paymentProviderEnvironment: ProviderRuntimeStatus;
  kycProvider: string | null;
  kycProviderEnvironment: ProviderRuntimeStatus;
  cardIssuingProvider: string | null;
  cardIssuingProviderEnvironment: ProviderRuntimeStatus;
  emailDelivery: EmailDeliveryStatus;
  smsDelivery: SmsDeliveryStatus;
  scheduledJobs: ProviderConfigStatus;
}

function computeEmailDeliveryStatus(env: ServerEnv): EmailDeliveryStatus {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM_ADDRESS) return "console_log_only_no_provider";
  if (!env.EMAIL_DELIVERY_ENABLED) return "console_log_only_kill_switch";
  return "resend";
}

/** Exported (not just used internally) — PRSprint 16's own notification-preferences route reuses this exact decision to tell a user honestly whether SMS is live right now, without duplicating the logic getSmsSender.ts itself uses. */
export function computeSmsDeliveryStatus(env: ServerEnv): SmsDeliveryStatus {
  const hasSender = Boolean(env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER);
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !hasSender) return "console_log_only_no_provider";
  if (!env.SMS_DELIVERY_ENABLED) return "console_log_only_kill_switch";
  return "twilio";
}

/** Resolves a configured provider name against the live capability registry — "unavailable" whenever nothing is registered under that name (including when the env var itself is unset), never a sandbox label. */
function resolveProviderRuntimeStatus(providerName: string | undefined): ProviderRuntimeStatus {
  return findProviderCapabilityDescriptor(providerName)?.environment ?? "unavailable";
}

/** Pure classification function — kept separate from the process.env-reading singleton below so it can be unit-tested with constructed ServerEnv values, mirroring parseServerEnv/getServerEnv's own split in src/config/env.ts. */
export function computeEnvironmentStatus(env: ServerEnv): AdminEnvironmentStatus {
  return {
    appEnv: env.APP_ENV,
    nodeEnv: env.NODE_ENV,
    database: env.DATABASE_URL ? "configured" : "not_configured",
    documentStorage: env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? "configured" : "not_configured",
    paymentProvider: env.PAYMENT_PROVIDER ?? null,
    paymentProviderEnvironment: resolveProviderRuntimeStatus(env.PAYMENT_PROVIDER),
    kycProvider: env.KYC_PROVIDER ?? null,
    kycProviderEnvironment: resolveProviderRuntimeStatus(env.KYC_PROVIDER),
    cardIssuingProvider: env.CARD_ISSUING_PROVIDER ?? null,
    cardIssuingProviderEnvironment: resolveProviderRuntimeStatus(env.CARD_ISSUING_PROVIDER),
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
