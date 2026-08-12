/**
 * Sprint 13: "approximately 3 business days" (Saturday/Sunday excluded, no US federal holiday
 * calendar — no holiday calendar is specified anywhere in this project's docs, so this is a
 * documented simplification, consistent with this project's existing precedent of flagging
 * simplifications rather than silently under- or over-building, e.g. Sprint 10's caller-supplied
 * processor fees). UTC throughout to avoid local-timezone-dependent day-boundary bugs.
 */
export function addBusinessDays(from: Date, businessDays: number): Date {
  const result = new Date(from.getTime());
  let remaining = businessDays;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) {
      remaining -= 1;
    }
  }
  return result;
}
