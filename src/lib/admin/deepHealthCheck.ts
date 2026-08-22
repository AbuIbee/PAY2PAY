import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { getServerEnv } from "@/config/env";

export type ComponentStatus = "ok" | "unreachable" | "misconfigured";

export interface DeepHealthReport {
  database: ComponentStatus;
  environmentConfiguration: ComponentStatus;
  checkedAt: string;
}

/**
 * PRSprint 28 (docs/prsprints/PRSPRINT_28_ERROR_HANDLING_OBSERVABILITY_HEALTH_MONITORING.md):
 * "Admin-only system health view" — a live readiness check, distinct from `/api/health`'s pure
 * liveness probe (that one deliberately never touches the database, so it stays reliable even if a
 * dependency is down — see its own doc comment). Every field here is a coarse enum; never a raw
 * driver/connection-string error, never a secret value — "Health endpoints must not reveal secrets or
 * excessive infrastructure details."
 */
export async function runDeepHealthCheck(): Promise<DeepHealthReport> {
  let environmentConfiguration: ComponentStatus = "ok";
  try {
    getServerEnv();
  } catch {
    environmentConfiguration = "misconfigured";
  }

  let database: ComponentStatus = "ok";
  try {
    await getDb().execute(sql`SELECT 1`);
  } catch {
    database = "unreachable";
  }

  return { database, environmentConfiguration, checkedAt: new Date().toISOString() };
}
