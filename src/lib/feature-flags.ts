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
  // PRSprint 29 (docs/prsprints/PRSPRINT_29_BACKUPS_RECOVERY_ROLLBACK_INCIDENT_CONTROLS.md):
  // operational kill switches — "provide operational ability to disable: new payment initiation,
  // bank linking, provider processing, card operations... without destroying historical records."
  // All default `true` (normal operation); an operator flips the matching `FEATURE_*` env var to
  // `false` in Vercel during an incident to halt *new* activity of that kind immediately, with no
  // deploy required and no effect on already-scheduled/in-flight work or historical records.
  // `paymentInitiationEnabled` is enforced in PaymentService.reserveAttempt — the single choke point
  // every payment-creation path (createPayment/schedulePayment, provider-routed and manual alike)
  // already goes through (see that class's own doc comment).
  paymentInitiationEnabled: true,
  // Enforced in BankConnectionService.connectBankAccount — the single place a new bank connection is
  // ever created (see PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md).
  bankConnectionEnabled: true,
  // PRSprint 33 (docs/prsprints/PRSPRINT_33_FINAL_PRODUCTION_LAUNCH_CONTROLS_CLOSED_BETA.md):
  // master-spec items 153/199, "financial launch should be phased... use a small controlled cohort."
  // Default false (open signup, today's behavior, unchanged) — an operator sets
  // FEATURE_CLOSED_BETA_ENABLED=true to require a valid single-use invite code
  // (BetaInviteService) at signup. Enforced in the signup *route*
  // (src/app/api/auth/signup/route.ts), never inside AuthService.signup itself — see
  // BetaInviteService's own doc comment for why.
  closedBetaEnabled: false,
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
