import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatRelative, todayLocalIsoDate } from "./date";

describe("formatDate", () => {
  it("formats an ISO string as a medium date", () => {
    expect(formatDate("2026-08-13T00:00:00.000Z")).toMatch(/Aug 1[23], 2026/);
  });

  it("formats a Date instance the same way as an equivalent ISO string", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(formatDate(date)).toBe(formatDate("2026-01-01T00:00:00.000Z"));
  });
});

describe("formatDateTime", () => {
  it("includes both date and time", () => {
    const result = formatDateTime("2026-08-13T14:45:00.000Z");
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("formatRelative", () => {
  it("describes a moment a few minutes in the past", () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const fiveMinutesAgo = new Date("2026-08-13T11:55:00.000Z");
    expect(formatRelative(fiveMinutesAgo, now)).toMatch(/5 minutes ago/);
  });

  it("describes a moment in the future", () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const inTwoDays = new Date("2026-08-15T12:00:00.000Z");
    expect(formatRelative(inTwoDays, now)).toMatch(/in 2 days/);
  });
});

describe("todayLocalIsoDate", () => {
  it("Agreement Lifecycle V2 UAT (Defect 5): formats a given Date as YYYY-MM-DD using its own local getters (never UTC), so a date <input>'s min matches the browser's own calendar day", () => {
    // 11pm on Jan 5th, local time — a naive toISOString()-based implementation would report Jan 6th
    // for any timezone east of UTC, or the wrong day generally depending on offset; this must not.
    const local = new Date(2026, 0, 5, 23, 0, 0);
    expect(todayLocalIsoDate(local)).toBe("2026-01-05");
  });

  it("zero-pads single-digit months and days", () => {
    const local = new Date(2026, 2, 4);
    expect(todayLocalIsoDate(local)).toBe("2026-03-04");
  });

  it("defaults to the current moment when called with no argument", () => {
    const before = new Date();
    const result = todayLocalIsoDate();
    expect(result).toBe(todayLocalIsoDate(before));
  });
});
