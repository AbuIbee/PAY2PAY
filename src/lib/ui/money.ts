/**
 * Sprint 18B: single money formatter for the whole UI ("Use one formatter.
 * Browser formats only; backend calculates."). Every amount in this codebase
 * is minor units (integer cents) — never format a raw minor-units number
 * with toFixed(2) inline in a component; always go through here.
 */
export function formatMoney(minorUnits: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
  }).format(minorUnits / 100);
}

/** Same as formatMoney but never renders a sign — for contexts that add their own +/- prefix. */
export function formatMoneyAbs(minorUnits: number, currency = "USD"): string {
  return formatMoney(Math.abs(minorUnits), currency);
}
