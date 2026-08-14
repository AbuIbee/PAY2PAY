import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneyAbs } from "./money";

describe("formatMoney", () => {
  it("formats minor units as USD currency", () => {
    expect(formatMoney(12345)).toBe("$123.45");
  });

  it("formats zero", () => {
    expect(formatMoney(0)).toBe("$0.00");
  });

  it("formats negative amounts with a leading minus sign", () => {
    expect(formatMoney(-500)).toBe("-$5.00");
  });

  it("rounds to two decimal places for sub-cent input", () => {
    expect(formatMoney(1)).toBe("$0.01");
  });
});

describe("formatMoneyAbs", () => {
  it("never renders a sign, even for negative minor units", () => {
    expect(formatMoneyAbs(-500)).toBe("$5.00");
    expect(formatMoneyAbs(500)).toBe("$5.00");
  });
});
