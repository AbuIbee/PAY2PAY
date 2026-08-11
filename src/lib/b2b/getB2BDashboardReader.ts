import "server-only";
import { DrizzleB2BDashboardReader } from "./drizzleB2BDashboardReader";
import type { B2BDashboardReader } from "./b2bDashboardReader";

let cached: B2BDashboardReader | null = null;

/** Lazily creates (and memoizes) the production B2BDashboardReader. Mirrors getDocumentStorage.ts's pattern. */
export function getB2BDashboardReader(): B2BDashboardReader {
  if (!cached) {
    cached = new DrizzleB2BDashboardReader();
  }
  return cached;
}
