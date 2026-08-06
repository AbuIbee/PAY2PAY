/**
 * Minimal feature-flag registry. Each flag has a hard-coded default, which
 * can be overridden per-environment via a `FEATURE_<FLAG_NAME>` env var set
 * to the literal string "true" or "false" — no external flag service is
 * needed for Phase 0's scope.
 *
 * This module is safe to import from server code. It intentionally does not
 * import "server-only": calling it from a client component still works, but
 * only ever sees the hard-coded default (non-`NEXT_PUBLIC_*` env vars are
 * never sent to the browser by Next.js), so there is no secret-leak risk —
 * just no client-side runtime override, which is an acceptable Phase 0
 * limitation.
 */
export const FEATURE_FLAGS = {
  /** Placeholder flag demonstrating the mechanism; remove once a real flag needs it. */
  exampleFoundationFlag: false,
} as const satisfies Record<string, boolean>;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;

function envOverrideKey(flag: FeatureFlagName): string {
  return `FEATURE_${flag.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

export function isFeatureEnabled(flag: FeatureFlagName): boolean {
  const override = process.env[envOverrideKey(flag)];
  if (override === "true") return true;
  if (override === "false") return false;
  return FEATURE_FLAGS[flag];
}
