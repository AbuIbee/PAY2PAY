import "server-only";
import { z } from "zod";

/**
 * Server-only environment schema. This module must never be imported from a
 * client component — the `server-only` import above makes that a build-time
 * error rather than a runtime leak.
 *
 * `parseServerEnv` is a pure function so tests can validate rejection
 * behavior without touching global `process.env`.
 */
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // APP_ENV extends NODE_ENV with a "staging" option, since Next.js itself
  // only distinguishes development/test/production (docs/IMPLEMENTATION_PLAN.md
  // Phase 0 requires a development/test/staging/production config pattern).
  APP_ENV: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    ),
  // Pepper used by the audit hash-chaining function (src/lib/audit/hash.ts)
  // so the chain cannot be recomputed by someone who only has DB read access.
  AUDIT_HASH_SECRET: z
    .string()
    .min(16, "AUDIT_HASH_SECRET must be at least 16 characters"),
  // Pepper mixed into every password hash (src/lib/auth/password.ts) so a
  // stolen database alone is not enough to offline-brute-force credentials.
  AUTH_PASSWORD_PEPPER: z
    .string()
    .min(16, "AUTH_PASSWORD_PEPPER must be at least 16 characters"),
  // Base URL used to build links inside emails (verification, password
  // reset, staff/agreement/relationship invitations, and every notification
  // CTA link) — the one centralized source every link-building service reads
  // via getServerEnv().APP_URL (never a per-request Host header, so no
  // client-supplied value can ever substitute a different domain here).
  // Server-only: nothing renders this in a page, so it doesn't need a
  // NEXT_PUBLIC_ prefix. Defaults to localhost for development convenience;
  // must be set to the real deployed origin in preview/staging/production.
  //
  // PRSprint 14 production defect (fixed): this variable was never actually
  // provisioned in any Vercel environment, so production silently ran on the
  // "http://localhost:3000" default — every production email's link pointed
  // at localhost. The superRefine below turns that failure mode from silent
  // (a broken link nobody notices until a user reports it) into loud (the
  // app refuses to serve any request that touches getServerEnv() at all) —
  // matching AUDIT_HASH_SECRET/AUTH_PASSWORD_PEPPER's existing "throw a clear
  // error rather than silently degrade" precedent in this same file.
  APP_URL: z.string().url().default("http://localhost:3000"),
  // Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md): Supabase Storage
  // credentials for the private signed-agreement-PDF bucket. Optional at the environment-schema
  // level (so the app still starts, and every route unrelated to PDF storage still works, with
  // neither configured) — SupabaseDocumentStorage itself throws a clear ConfigurationError only
  // when a document-storage operation is actually attempted without them, mirroring "Auth routes
  // fail safely with no live database" from Phase 0.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  // Sprint 9 (docs/sprints/SPRINT_09_PaymentProviderAbstraction _Sandbox.md): HMAC secrets for the
  // sandbox/mock payment and KYC/KYB provider webhook signatures. Optional at the environment-schema
  // level (mirrors SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY above) so the app still starts with
  // neither configured; getPaymentProvider()/getKycProvider() throw a clear ConfigurationError only
  // when a payment or KYC operation is actually attempted without one.
  PAYMENT_SANDBOX_WEBHOOK_SECRET: z.string().min(16).optional(),
  KYC_SANDBOX_WEBHOOK_SECRET: z.string().min(16).optional(),
  // PRSprint 21 (docs/prsprints/PRSPRINT_21_PRODUCTION_FINANCIAL_PROVIDER_ARCHITECTURE.md): which
  // registered provider implementation getPaymentProvider()/getKycProvider() construct — see
  // src/lib/providers/providerCapabilities.ts for the full registry. Only "sandbox" is registered
  // today; adding a real adapter later means adding its name to this enum, not changing any
  // consuming code (PaymentService/KycVerificationService depend only on the interface). Rejecting
  // an unregistered value at the schema level (rather than accepting any string) is deliberate —
  // a typo or a not-yet-implemented provider name must fail loudly at startup, never silently fall
  // through to sandbox behavior while claiming something else was selected.
  PAYMENT_PROVIDER: z.enum(["sandbox"]).default("sandbox"),
  KYC_PROVIDER: z.enum(["sandbox"]).default("sandbox"),
  // PRSprint 24 (docs/prsprints/PRSPRINT_24_DEBIT_CARD_ISSUANCE_CARD_LIFECYCLE.md): mirrors
  // PAYMENT_PROVIDER/KYC_PROVIDER exactly — see providerCapabilities.ts's registry.
  CARD_ISSUING_PROVIDER: z.enum(["sandbox"]).default("sandbox"),
  CARD_SANDBOX_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Sprint 13 (docs/sprints/SPRINT_13_FailedPayments_RetryWorkflow.md): shared secret protecting
  // POST /api/scheduler/retry-failed-payments — Vercel Cron Jobs automatically send
  // `Authorization: Bearer <CRON_SECRET>` to the route(s) configured in vercel.json when this
  // environment variable is set, which is the idiomatic "background job" mechanism on a platform
  // with no persistent worker process (this sprint's own "compatible with Vercel architecture"
  // requirement). Optional at the schema level, mirroring PAYMENT_SANDBOX_WEBHOOK_SECRET above — the
  // route itself throws a clear ConfigurationError only when actually invoked without it configured.
  CRON_SECRET: z.string().min(16).optional(),
  // PRSprint 14 (docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md): production email provider
  // (Resend) configuration. Optional at the schema level, mirroring every other provider secret
  // above — the app still starts with none of these configured; src/lib/notify/getEmailSender.ts
  // falls back to ConsoleEmailSender (log-only) whenever RESEND_API_KEY is absent, so development,
  // test, and any environment that hasn't been given a live key keep working exactly as before this
  // PRSprint. Never logged, never returned from an API response, never written into a notification
  // payload — src/lib/notify/resendEmailSender.ts is the only place RESEND_API_KEY is read.
  RESEND_API_KEY: z.string().min(1).optional(),
  // The verified sending address/display name shown to recipients. No default — a placeholder
  // "from" address would be worse than failing closed, so ResendEmailSender throws a
  // ConfigurationError if a send is attempted with RESEND_API_KEY set but this unset.
  EMAIL_FROM_ADDRESS: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().min(1).default("PAY2PAY"),
  // HMAC secret Resend signs its delivery webhooks with (Svix-compatible: "whsec_" + base64),
  // verified in src/lib/notify/verifyResendWebhookSignature.ts. Optional at the schema level; the
  // webhook route itself throws a clear ConfigurationError only when actually invoked without it.
  RESEND_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Global kill switch (Detailed Scope, PRSPRINT_14_PRODUCTION_EMAIL.md): set to "false" to force
  // every outbound email back to ConsoleEmailSender (log-only, nothing actually sent) without
  // removing RESEND_API_KEY or redeploying — an operational incident lever, not a feature flag.
  // Defaults to enabled so provisioning RESEND_API_KEY alone is sufficient to go live.
  EMAIL_DELIVERY_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md): production SMS provider (Twilio)
  // configuration. Optional at the schema level, mirroring RESEND_API_KEY above — the app still
  // starts with none of these configured; src/lib/notify/getSmsSender.ts falls back to
  // ConsoleSmsSender (log-only) whenever TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN are absent. Never
  // logged, never returned from an API response, never written into a notification payload —
  // src/lib/notify/twilioSmsSender.ts is the only place TWILIO_AUTH_TOKEN is read.
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  // Either a Messaging Service SID (Twilio's recommended production pattern — supports A2P 10DLC
  // sender pools/number rotation transparently) or a single From number. Messaging Service takes
  // priority when both are set; TwilioSmsSender throws a clear ConfigurationError if a send is
  // attempted with neither configured.
  TWILIO_MESSAGING_SERVICE_SID: z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z.string().min(1).optional(),
  // HMAC-SHA1 signature verification for Twilio's inbound-message and status-callback webhooks
  // (src/lib/notify/verifyTwilioWebhookSignature.ts) uses TWILIO_AUTH_TOKEN directly — Twilio has
  // no separate webhook secret the way Resend does.
  //
  // Global kill switch, mirrors EMAIL_DELIVERY_ENABLED exactly — set to "false" to force every
  // outbound SMS back to ConsoleSmsSender without removing credentials or redeploying.
  SMS_DELIVERY_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
}).superRefine((data, ctx) => {
  // PRSprint 14 production defect fix: APP_URL's own default only makes sense in
  // development/test — a production deployment that ends up on this default means the
  // real value was never provisioned, which previously fell through silently (see
  // APP_URL's own doc comment above). Cross-field, so it has to live in superRefine
  // rather than on the field's own schema, which can't see APP_ENV.
  if (data.APP_ENV !== "production") return;
  let hostname = "";
  try {
    hostname = new URL(data.APP_URL).hostname;
  } catch {
    // Unparseable already fails APP_URL's own z.string().url() check — nothing to add here.
    return;
  }
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["APP_URL"],
      message: 'APP_URL resolves to localhost while APP_ENV is "production" — set APP_URL to the real production origin (e.g. https://paid2you.com) in this environment\'s configuration.',
    });
  }
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvironmentValidationError extends Error {
  constructor(issues: z.ZodIssue[]) {
    const details = issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    super(`Invalid environment configuration:\n${details}`);
    this.name = "EnvironmentValidationError";
  }
}

/**
 * Parses and validates a raw environment object. Throws
 * {@link EnvironmentValidationError} when a required value is missing or
 * malformed — never falls back to a silently-invalid default for required
 * fields.
 *
 * If `DATABASE_URL` is unset but `POSTGRES_URL` is present, `POSTGRES_URL` is
 * used in its place. Vercel's native Postgres storage integration provisions
 * `POSTGRES_URL` (not `DATABASE_URL`) into the project's environment
 * variables, so this lets that integration work without requiring a
 * hand-added duplicate `DATABASE_URL` variable in the Vercel dashboard.
 * `DATABASE_URL` still wins when both are set.
 */
export function parseServerEnv(raw: Record<string, string | undefined>): ServerEnv {
  const normalized = {
    ...raw,
    DATABASE_URL: raw.DATABASE_URL ?? raw.POSTGRES_URL,
  };
  const result = serverEnvSchema.safeParse(normalized);
  if (!result.success) {
    throw new EnvironmentValidationError(result.error.issues);
  }
  return result.data;
}

let cachedServerEnv: ServerEnv | null = null;

/**
 * Memoized accessor for the validated server environment. Call this lazily,
 * from the specific server-side code path that needs it (e.g. the DB client
 * factory), not at module top-level of every route — routes that don't touch
 * the database or audit hashing (like the health check) should not fail to
 * start just because a downstream secret hasn't been configured yet.
 */
export function getServerEnv(): ServerEnv {
  if (!cachedServerEnv) {
    cachedServerEnv = parseServerEnv(process.env);
  }
  return cachedServerEnv;
}
