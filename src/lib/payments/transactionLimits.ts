/**
 * PRSprint 33 (docs/prsprints/PRSPRINT_33_FINAL_PRODUCTION_LAUNCH_CONTROLS_CLOSED_BETA.md), master-spec
 * item 154: "Put transaction limits in place initially: per-payment limit; daily account limit;
 * business-specific risk limits; card limits where supported." Mirrors feature-flags.ts's own
 * env-override pattern (a `<NAME>` env var, hard-coded default otherwise) — no external config service
 * needed for a launch-controls scope this small.
 *
 * The default values below are a conservative starting guardrail for a closed-beta launch, not a
 * business decision this session is positioned to make — the Product Owner should set the real
 * production limits via the env vars below before any real-money launch; nothing here should be read
 * as the actual approved limit. Only a per-payment cap is enforced today (PaymentService.reserveAttempt);
 * a daily/rolling-window account limit needs a new aggregate-query repository method and is a
 * documented known limitation, not silently implemented as a no-op.
 */
const DEFAULT_MAX_PAYMENT_MINOR_UNITS = 1_000_000; // $10,000 — placeholder, see doc comment above.
const DEFAULT_REVIEW_THRESHOLD_MINOR_UNITS = 200_000; // $2,000 — placeholder, see doc comment above.

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Hard cap — PaymentService.reserveAttempt rejects any single payment above this with a ValidationError. */
export function getMaxPaymentMinorUnits(): number {
  return readPositiveIntEnv("MAX_PAYMENT_MINOR_UNITS", DEFAULT_MAX_PAYMENT_MINOR_UNITS);
}

/** Soft threshold — a payment at or above this is still created normally, but flagged via an audit event ("payment_flagged_for_review") for admin visibility in the existing audit log. Never blocks. */
export function getReviewThresholdMinorUnits(): number {
  return readPositiveIntEnv("PAYMENT_REVIEW_THRESHOLD_MINOR_UNITS", DEFAULT_REVIEW_THRESHOLD_MINOR_UNITS);
}
