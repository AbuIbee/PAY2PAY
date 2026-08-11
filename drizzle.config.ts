import type { Config } from "drizzle-kit";

/**
 * drizzle-kit configuration for `npm run db:generate` / `npm run db:migrate`.
 * Reads DATABASE_URL directly (not via src/config/env.ts) because drizzle-kit
 * runs as a standalone CLI outside the Next.js server process. Falls back to
 * POSTGRES_URL, which is what Vercel's native Postgres storage integration
 * provisions, mirroring the same fallback in src/config/env.ts.
 */
export default {
  schema: "./src/db/schema/index.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "",
  },
} satisfies Config;
