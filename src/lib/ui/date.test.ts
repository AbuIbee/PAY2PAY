import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatRelative } from "./date";

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
