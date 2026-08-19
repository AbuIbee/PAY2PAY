import "server-only";
import { getServerEnv, type ServerEnv } from "@/config/env";
import { getProviderCapabilityDescriptor, type ProviderEnvironment } from "@/lib/providers/providerCapabilities";

/**
 * PRSprint 04 (docs/prsprints/PRSPRINT_04_SECRETS_ENVIRONMENT_PRODUCTION_SEPARATION.md): an
 * admin-only, secret-free view of which providers are configured and what mode each one runs in.
 * Every field is a boolean-like enum derived from *whether a var is set*, never the var's value —
 * this module must never return, log, or expose an actual secret. It also must never claim a
 * capability is "live" that this codebase cannot actually reach.
 *
 * PRSprint 21 (docs/prsprints/PRSPRINT_21_PRODUCTION_FINANCIAL_PROVIDER_ARCHITECTURE.md) update:
 * `paymentProvider`/`kycProvider` are no longer hardcoded `"sandbox"` literals — they now read the
 * selected provider name from `PAYMENT_PROVIDER`/`KYC_PROVIDER` (src/config/env.ts) and resolve its
 * declared `environment` from the capability registry (src/lib/providers/providerCapabilities.ts),
 * mirroring `emailDelivery`/`smsDelivery`'s already-established "read the identical inputs the real
 * factory reads, so this view can never drift from what the code actually does" pattern. Today this
 * still always resolves to `"sandbox"` (only provider registered), but the mechanism is now the same
 * genuinely-conditional one every other provider status field already uses — this satisfies "document
 * live approval state" and "provider status monitoring" for the day a production provider exists,
 * without this file needing to change again then.
 */
export type ProviderConfigStatus = "configured" | "not_configured";
export type EmailDeliveryStatus = "resend" | "console_log_only_no_provider" | "console_log_only_kill_switch";
export type SmsDeliveryStatus = "twilio" | "console_log_only_no_provider" | "console_log_only_kill_switch";

export interface AdminEnvironmentStatus {
  appEnv: string;
  nodeEnv: string;
  database: ProviderConfigStatus;
  documentStorage: ProviderConfigStatus;
  paymentProvider: string;
  paymentProviderEnvironment: ProviderEnvironment;
  kycProvider: string;
  kycProviderEnvironment: ProviderEnvironment;
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

// PRSprint 21: maps the env-var selector value (PAYMENT_PROVIDER/KYC_PROVIDER — "sandbox") to the
// concrete provider's own `providerName` (the capability registry's key, e.g. "sandbox_mock") —
// these two vocabularies are deliberately distinct (the env var selects a *kind* of provider; the
// registry key identifies one *specific implementation*, matching getPaymentProvider.ts's own
// switch). Extending this to a real provider means adding a case here alongside its registry entry.
function resolveProviderName(selector: "sandbox", kind: "payment" | "kyc"): string {
  if (selector === "sandbox") return kind === "payment" ? "sandbox_mock" : "sandbox_kyc_mock";
  const exhaustive: never = selector;
  throw new Error(`Unhandled provider selector: ${String(exhaustive)}`);
}

/** Pure classification function — kept separate from the process.env-reading singleton below so it can be unit-tested with constructed ServerEnv values, mirroring parseServerEnv/getServerEnv's own split in src/config/env.ts. */
export function computeEnvironmentStatus(env: ServerEnv): AdminEnvironmentStatus {
  const paymentProvider = resolveProviderName(env.PAYMENT_PROVIDER, "payment");
  const kycProvider = resolveProviderName(env.KYC_PROVIDER, "kyc");
  return {
    appEnv: env.APP_ENV,
    nodeEnv: env.NODE_ENV,
    database: env.DATABASE_URL ? "configured" : "not_configured",
    documentStorage: env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? "configured" : "not_configured",
    paymentProvider,
    paymentProviderEnvironment: getProviderCapabilityDescriptor(paymentProvider).environment,
    kycProvider,
    kycProviderEnvironment: getProviderCapabilityDescriptor(kycProvider).environment,
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
