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
  // Production incident (connection-pool exhaustion): Supabase's Supavisor transaction-mode pooler
  // does not guarantee the same backend connection persists across statements, which breaks
  // server-side prepared statements — postgres.js's own documented requirement for connecting
  // through a transaction pooler. Session mode (this app's prior DATABASE_URL) ties one dedicated
  // backend connection to this client for its entire lifetime, which a small pool exhausts under
  // ordinary serverless concurrency; transaction mode multiplexes many such clients over a much
  // smaller set of backend connections, which is what actually fixes that exhaustion.
  const queryClient = postgres(DATABASE_URL, { max: 1, prepare: false });
  cachedDb = drizzle(queryClient, { schema });
  return cachedDb;
}
