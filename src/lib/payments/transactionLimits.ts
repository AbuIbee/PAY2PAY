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

/**
 * SPRINT_19_FraudRisk_SecurityHardening: closes the "a daily/rolling-window account limit needs a
 * new aggregate-query repository method" gap PRSprint 33 documented above —
 * `PaymentAttemptRepository.listRecentByPayer` is that method, enforced in
 * `PaymentService.reserveAttempt`. Values below are the same kind of conservative placeholder as the
 * per-payment cap — not an approved business decision — classified `PRODUCT OWNER CONFIGURATION
 * REQUIRED` in the completion report, same as the per-payment default.
 *
 * "New-account" and "high-risk-account" restrictions (master-spec item 154's remaining two
 * sub-items) are deliberately NOT implemented as a third/fourth numeric knob here: doing so before
 * any actual account-age or risk-signal integration exists would be inventing financial policy, not
 * building enforcement architecture. `PaymentService.reserveAttempt` is already the single choke
 * point every payment-creation path goes through, so wiring an account-age check or the new
 * `RiskEventService` (docs/prsprints — SPRINT_19 §12) in later is additive, not a redesign.
 */
const DEFAULT_DAILY_AMOUNT_LIMIT_MINOR_UNITS = 5_000_000; // $50,000 — placeholder, see doc comment above.
const DEFAULT_DAILY_ATTEMPT_COUNT_LIMIT = 20; // placeholder, see doc comment above.
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

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

/** Rolling 24h cap on total amount (succeeded + still-in-flight; a failed/canceled attempt never moved money) one payer may move. */
export function getDailyAmountLimitMinorUnits(): number {
  return readPositiveIntEnv("DAILY_PAYMENT_AMOUNT_LIMIT_MINOR_UNITS", DEFAULT_DAILY_AMOUNT_LIMIT_MINOR_UNITS);
}

/** Rolling 24h cap on payment *attempts* (including failed ones — this is a velocity/card-testing-abuse control, not a money-moved control). */
export function getDailyAttemptCountLimit(): number {
  return readPositiveIntEnv("DAILY_PAYMENT_ATTEMPT_COUNT_LIMIT", DEFAULT_DAILY_ATTEMPT_COUNT_LIMIT);
}

export function getRollingWindowMs(): number {
  return ROLLING_WINDOW_MS;
}

/** Statuses that never moved money and never will — excluded from the daily *amount* sum, but still counted toward the daily *attempt* count. */
const NON_MOVING_STATUSES: ReadonlySet<string> = new Set(["failed", "canceled"]);

export function summarizeRecentActivity(records: ReadonlyArray<{ status: string; amountMinorUnits: number }>): {
  amountMinorUnits: number;
  attemptCount: number;
} {
  let amountMinorUnits = 0;
  for (const record of records) {
    if (!NON_MOVING_STATUSES.has(record.status)) amountMinorUnits += record.amountMinorUnits;
  }
  return { amountMinorUnits, attemptCount: records.length };
}
