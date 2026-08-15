import "server-only";
import { getServerEnv, type ServerEnv } from "@/config/env";

/**
 * PRSprint 04 (docs/prsprints/PRSPRINT_04_SECRETS_ENVIRONMENT_PRODUCTION_SEPARATION.md): an
 * admin-only, secret-free view of which providers are configured and what mode each one runs in.
 * Every field is a boolean-like enum derived from *whether a var is set*, never the var's value —
 * this module must never return, log, or expose an actual secret. It also must never claim a
 * capability is "live" that this codebase cannot actually reach: `getPaymentProvider()` and
 * `getKycProvider()` are unconditionally wired to their sandbox implementations (no live adapter
 * exists in this codebase yet — that is PRSprint 21's scope), and `notify/*Sender.ts` is
 * console-log-only (Sprint 17's own documented limitation) — so `paymentProvider`/`kycProvider`/
 * `emailDelivery`/`smsDelivery` below are fixed labels reflecting that reality by construction, not
 * environment-variable-driven toggles, so this view can never drift from what the code actually does.
 */
export type ProviderConfigStatus = "configured" | "not_configured";

export interface AdminEnvironmentStatus {
  appEnv: string;
  nodeEnv: string;
  database: ProviderConfigStatus;
  documentStorage: ProviderConfigStatus;
  paymentProvider: "sandbox";
  kycProvider: "sandbox";
  emailDelivery: "console_log_only";
  smsDelivery: "console_log_only";
  scheduledJobs: ProviderConfigStatus;
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
    emailDelivery: "console_log_only",
    smsDelivery: "console_log_only",
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
