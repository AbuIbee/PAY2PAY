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
 */
export function parseServerEnv(raw: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(raw);
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
