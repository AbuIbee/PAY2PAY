import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getServerEnv } from "@/config/env";
import * as schema from "./schema";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let cachedDb: Database | null = null;

/**
 * Lazily creates (and memoizes) the Drizzle client. Nothing in Phase 0 calls
 * this at module-load time, so the app can start, build, and serve the
 * health check without a reachable Postgres instance configured — the first
 * real caller arrives in a later phase (docs/IMPLEMENTATION_PLAN.md Phase 1+).
 */
export function getDb(): Database {
  if (cachedDb) return cachedDb;
  const { DATABASE_URL } = getServerEnv();
  const queryClient = postgres(DATABASE_URL, { max: 1 });
  cachedDb = drizzle(queryClient, { schema });
  return cachedDb;
}
