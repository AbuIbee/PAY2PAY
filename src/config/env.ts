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
  //
  // Production-only customer email URLs (fixed): a prior fix had
  // parseServerEnv fall back to Vercel's auto-injected VERCEL_URL when APP_URL
  // wasn't explicitly set, so an *unconfigured* Preview deployment wouldn't
  // silently point every link at localhost. That solved the localhost defect
  // but introduced a worse one: any Preview deployment that can also send real
  // external email (RESEND_API_KEY is provisioned for Preview, not just
  // Production, in this project) would embed *that ephemeral Preview
  // deployment's own* vercel.app URL in a real, externally-delivered customer
  // email — coupling a customer's invitation/verification link to whichever
  // branch build happened to execute the send job. Product decision: a
  // customer-facing email must always link to the canonical production origin
  // regardless of which deployment sent it; Preview may still be used for
  // in-browser application testing, which never depends on APP_URL at all.
  // The VERCEL_URL fallback is removed below — APP_URL now only ever resolves
  // to an explicit value or this field's own localhost default. The superRefine
  // below fails loudly (same "refuses to serve any request" mechanism as the
  // production-localhost case) whenever RESEND_API_KEY is configured — i.e.
  // this environment is actually capable of sending real external email — but
  // APP_URL is not an explicit, canonical (non-localhost, non-Vercel-domain)
  // value. Any environment meant to send real customer email — Preview
  // included — must have its own explicit APP_URL provisioned, pointing at the
  // real production origin.
  APP_URL: z.string().url().default("http://localhost:3000"),
  // Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md): Supabase Storage
  // credentials for the private signed-agreement-PDF bucket. Optional at the environment-schema
  // level (so the app still starts, and every route unrelated to PDF storage still works, with
  // neither configured) — SupabaseDocumentStorage itself throws a clear ConfigurationError only
  // when a document-storage operation is actually attempted without them, mirroring "Auth routes
  // fail safely with no live database" from Phase 0.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  // PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION: which registered LIVE provider implementation
  // getPaymentProvider()/getKycProvider()/getCardIssuingProvider() construct — see
  // src/lib/providers/providerCapabilities.ts for the full registry. That registry is empty today (no
  // live provider has been approved/selected — B-1 remains on hard hold), so any value here — set,
  // unset, or "sandbox" — resolves to `ProviderNotAvailableError` at the factory. Deliberately a plain
  // string, not a `z.enum([...])` of one sandbox literal (Sprint 9/PRSprint 21's prior shape): there is
  // no longer any accepted "sandbox" enum member for a value to validly equal. The superRefine below
  // additionally rejects the literal sandbox/mock/fake/demo/test/dummy/stub/simulated family of values
  // outright, so a deployed environment that is accidentally (or maliciously) handed one of these
  // fails CLOSED at startup/environment-parse time — not merely "unregistered, so unavailable" — never
  // silently falls through to sandbox behavior while claiming something else was selected.
  PAYMENT_PROVIDER: z.string().min(1).optional(),
  KYC_PROVIDER: z.string().min(1).optional(),
  CARD_ISSUING_PROVIDER: z.string().min(1).optional(),
  // PAID2YOU — B0-D ADYEN PHASE 1 (Payment Provider Foundation): required only when
  // PAYMENT_PROVIDER=adyen — src/lib/payments/getPaymentProvider.ts throws a clear ConfigurationError
  // at construction time if any of these four are missing, mirroring every other provider secret in
  // this file's "optional at the schema level, enforced at the point of use" established pattern.
  // Never a placeholder/invented value — see AdyenPaymentProvider's own module doc comment for exactly
  // what each is used for and where it comes from in the Adyen Customer Area.
  ADYEN_API_KEY: z.string().min(1).optional(),
  ADYEN_MERCHANT_ACCOUNT: z.string().min(1).optional(),
  // The account-specific live URL prefix (Developers > API URLs > Prefix) — Adyen live Checkout
  // endpoints have no shared/generic host, only this one. This adapter never targets a *-test.adyen.com
  // endpoint under any configuration; there is no such code path to enable.
  ADYEN_LIVE_PREFIX: z.string().min(1).optional(),
  // HMAC key for the Standard (payments) webhook subscription specifically — distinct from any future
  // Balance Platform webhook HMAC key, which is a later B0-D phase's own separate secret.
  ADYEN_PAYMENTS_HMAC_KEY: z.string().min(1).optional(),
  // PAID2YOU — B0-D ADYEN PHASE 2 (bank-account collection/tokenization): HMAC key for the SEPARATE
  // "Recurring tokens life cycle events" webhook subscription (token created/updated/disabled) — a
  // distinct Adyen webhook subscription from ADYEN_PAYMENTS_HMAC_KEY above, with its own
  // independently-generated key; the two are never interchangeable. Optional at the schema level,
  // mirroring every other provider secret's established convention — the token-lifecycle webhook
  // route itself throws a clear ConfigurationError (and AdyenPaymentProvider.
  // verifyTokenLifecycleWebhookSignature fails closed) only when actually invoked without it.
  ADYEN_RECURRING_HMAC_KEY: z.string().min(1).optional(),
  // PAID2YOU — B0-D ADYEN PHASE 2A (final bank-security correction): EXTERNAL BLOCKER gate. Adyen's
  // own published help-center guidance confirms zero-value ACH authorization — the mechanism
  // `AdyenPaymentProvider.createBankAccountSession` uses to tokenize a bank account without a real
  // payment — requires the Adyen Support Team to explicitly enable it on the merchant account,
  // together with GIACT bank-account verification (itself Nacha-mandated for WEB-SEC-code ACH
  // e-commerce transactions). Neither is a capability this codebase can verify, activate, or assume —
  // it is an account-level, contractual fact only Adyen's own Customer Area / account team can
  // confirm. Defaults to unset (bank-linking stays unavailable — see
  // src/lib/relationships/getBankConnectionService.ts) specifically so this feature can never silently
  // "turn on" — an operator must explicitly set this to "true" only AFTER confirming with Adyen that
  // both zero-value ACH authorization and GIACT verification are actually active for the real
  // production merchant account. Never a proxy for "the code is ready" — the code is ready; this
  // represents an EXTERNAL, business-level confirmation this codebase has no way to obtain itself.
  ADYEN_ACH_TOKENIZATION_VERIFIED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // PAID2YOU — B0-D PHASE 3B (payout integrity): a SECOND, INDEPENDENT gate — deliberately never
  // satisfied merely by `PayoutService.confirmPayout` receiving non-empty `providerName`/
  // `providerPayoutReference` arguments. Those two fields prove a CALLER claims a provider confirmed
  // something; this flag is the only thing that says Paid2You has actually integrated a live,
  // authenticated payout-confirmation signal from a real provider at all (today: none — no Adyen
  // account, no Balance Platform/Legal Entity Management/Transfers API wiring exists). Defaults to
  // unset (`confirmPayout` fails closed — see `PayoutService`'s own doc comment) specifically so a
  // future route/webhook that calls `confirmPayout` with syntactically-valid-looking evidence can
  // never complete a payout before this is deliberately flipped by an operator, after real provider
  // integration exists. Never a proxy for "the code is ready" — the code is ready; this represents
  // whether ANY authenticated live-provider trigger for payout confirmation exists at all.
  PAYOUT_PROVIDER_INTEGRATION_VERIFIED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
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
  // PAID2YOU — B0-D TOTAL SANDBOX ELIMINATION: "if one of these values is supplied to any
  // deployed/runtime environment, startup or provider initialization must fail closed" — this is the
  // startup-time half of that (assertProviderAvailableForRuntime, invoked lazily by the provider
  // factories, is the runtime half). Case-insensitive substring match, not exact-equality, so a value
  // like "sandbox_v2" or "stripe-test-mode" is caught too, not just the bare literal.
  const FORBIDDEN_PROVIDER_VALUE_PATTERN = /sandbox|mock|fake|demo|dummy|stub|simulat|test/i;
  for (const field of ["PAYMENT_PROVIDER", "KYC_PROVIDER", "CARD_ISSUING_PROVIDER"] as const) {
    const value = data[field];
    if (value && FORBIDDEN_PROVIDER_VALUE_PATTERN.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field}="${value}" names a sandbox/mock/fake/demo/dummy/stub/simulated/test provider — these are never valid runtime values. Only a real, approved, live provider name registered in src/lib/providers/providerCapabilities.ts may be used.`,
      });
    }
  }

  let hostname = "";
  try {
    hostname = new URL(data.APP_URL).hostname;
  } catch {
    // Unparseable already fails APP_URL's own z.string().url() check — nothing to add here.
    return;
  }
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  // PRSprint 14 production defect fix: APP_URL's own default only makes sense in
  // development/test — a production deployment that ends up on this default means the
  // real value was never provisioned, which previously fell through silently (see
  // APP_URL's own doc comment above). Cross-field, so it has to live in superRefine
  // rather than on the field's own schema, which can't see APP_ENV.
  if (data.APP_ENV === "production" && isLocalhost) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["APP_URL"],
      message: 'APP_URL resolves to localhost while APP_ENV is "production" — set APP_URL to the real production origin (e.g. https://paid2you.com) in this environment\'s configuration.',
    });
  }

  // Production-only customer email URLs fix: independent of APP_ENV — this project also sends
  // real external email from Preview deployments (RESEND_API_KEY is provisioned there too, not
  // just Production). Any environment capable of that must have an explicit, canonical APP_URL;
  // never a Vercel deployment domain, which would couple a real customer's email link to whichever
  // ephemeral Preview build executed the send.
  const isVercelDeploymentDomain = hostname.endsWith(".vercel.app");
  if (data.RESEND_API_KEY && (isLocalhost || isVercelDeploymentDomain)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["APP_URL"],
      message: `RESEND_API_KEY is configured (this environment sends real external email), but APP_URL resolves to "${hostname}", not an explicit canonical production origin — set APP_URL to the real public origin (e.g. https://paid2you.com) in this environment's configuration. Customer-facing emails must never link to a Vercel deployment URL.`,
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
 *
 * `APP_URL` deliberately does *not* get the same treatment: it used to fall back to Vercel's
 * auto-injected `VERCEL_URL` (the unique hostname of the current deployment) when unset, so an
 * unconfigured Preview deployment wouldn't silently link every email at localhost. That fallback
 * was removed (production-only customer email URLs fix) — it let a real, externally-delivered
 * customer email embed whichever ephemeral Preview deployment happened to send it, instead of the
 * canonical production origin. `APP_URL` now only ever resolves to an explicit value or this
 * field's own localhost default; the schema's own superRefine fails loudly, for any environment
 * capable of sending real external email, if that explicit value is missing.
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
