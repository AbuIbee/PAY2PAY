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
  // PRSprint 21 (docs/prsprints/PRSPRINT_21_PRODUCTION_FINANCIAL_PROVIDER_ARCHITECTURE.md):
  // "Unavailable live functions are feature-gated" (acceptance criterion) / SPRINT_18C item 93,
  // "Production bank/card features should be feature-gated... until live provider approval exists."
  // Both default false because no live (production-tagged) payment or KYC/KYB provider is registered
  // anywhere in this codebase yet (see src/lib/providers/providerCapabilities.ts) — flipping either
  // on ahead of a real provider actually being wired would violate the Hard Stop rule these PRSprints
  // share ("never represent sandbox as live production functionality"). UI/routes that would offer a
  // genuinely live capability (real bank-account linking, real debit-card issuance) must check the
  // corresponding flag via isFeatureEnabled() before rendering/allowing it, alongside — not instead
  // of — checking the actual provider's own `providerEnvironment`.
  liveBankingEnabled: false,
  liveCardIssuanceEnabled: false,
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
