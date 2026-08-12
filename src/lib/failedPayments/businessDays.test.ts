import { describe, expect, it } from "vitest";
import { addBusinessDays } from "./businessDays";

describe("addBusinessDays", () => {
  it("skips weekends when adding 3 business days from a Monday", () => {
    const monday = new Date(Date.UTC(2026, 0, 5)); // 2026-01-05 is a Monday
    const result = addBusinessDays(monday, 3);
    expect(result.toISOString().slice(0, 10)).toBe("2026-01-08"); // Thursday
  });

  it("skips a weekend that falls within the window", () => {
    const thursday = new Date(Date.UTC(2026, 0, 8)); // Thursday
    const result = addBusinessDays(thursday, 3);
    // Fri(1), Sat/Sun skipped, Mon(2), Tue(3)
    expect(result.toISOString().slice(0, 10)).toBe("2026-01-13"); // Tuesday
  });

  it("returns the same instant unchanged when adding 0 business days", () => {
    const from = new Date(Date.UTC(2026, 0, 5, 12, 30));
    expect(addBusinessDays(from, 0).getTime()).toBe(from.getTime());
  });
});
