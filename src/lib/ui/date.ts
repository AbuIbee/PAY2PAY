/**
 * Sprint 18B: single date/time formatter set ("consistent local-time
 * presentation... never mix UTC and local silently"). Accepts Date | string
 * | number so components can pass API responses (JSON dates arrive as ISO
 * strings) directly.
 */
function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Plain calendar date, local time zone — e.g. "Aug 13, 2026". Use for due dates, deadlines. */
export function formatDate(value: Date | string | number): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(toDate(value));
}

/**
 * Full local date + time — e.g. "Aug 13, 2026, 2:45 PM". Use for anything
 * where the exact moment matters (audit/legal timestamps, signatures,
 * notifications) rather than just the day.
 */
export function formatDateTime(value: Date | string | number): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(toDate(value));
}

/**
 * Agreement Lifecycle V2 UAT (Defect 5 — first-payment-date calendar must not allow a past date):
 * today's date as YYYY-MM-DD in the *browser's* local time zone, for a date `<input>`'s `min`
 * attribute — deliberately client-side (`new Date()` with no args reads the visiting user's own
 * system clock/timezone), never a server-computed UTC date, which would be off by a day for anyone
 * west of UTC around midnight. Server-side validation (AgreementService.createDraft/
 * AgreementInvitationService.createInvitation) uses the existing, separately-established
 * schedule.ts `isPastDate` UTC-day-granularity check — same margin already accepted everywhere else
 * this codebase validates a date server-side.
 */
export function todayLocalIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Coarse "time ago" for lists (notifications, audit trails) where exact precision is less useful than recency. */
export function formatRelative(value: Date | string | number, now: Date = new Date()): string {
  const date = toDate(value);
  const diffMs = date.getTime() - now.getTime();
  const diffSeconds = Math.round(diffMs / 1000);
  const divisions: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  for (const [unit, secondsInUnit] of divisions) {
    if (Math.abs(diffSeconds) >= secondsInUnit) {
      return rtf.format(Math.round(diffSeconds / secondsInUnit), unit);
    }
  }
  return rtf.format(diffSeconds, "second");
}
