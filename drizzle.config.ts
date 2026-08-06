import type { Config } from "drizzle-kit";

/**
 * drizzle-kit configuration for `npm run db:generate` / `npm run db:migrate`.
 * Reads DATABASE_URL directly (not via src/config/env.ts) because drizzle-kit
 * runs as a standalone CLI outside the Next.js server process.
 */
export default {
  schema: "./src/db/schema/index.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
} satisfies Config;
