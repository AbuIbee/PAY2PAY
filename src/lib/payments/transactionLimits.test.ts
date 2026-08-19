import { afterEach, describe, expect, it } from "vitest";
import { getMaxPaymentMinorUnits, getReviewThresholdMinorUnits } from "./transactionLimits";

describe("transactionLimits", () => {
  afterEach(() => {
    delete process.env.MAX_PAYMENT_MINOR_UNITS;
    delete process.env.PAYMENT_REVIEW_THRESHOLD_MINOR_UNITS;
  });

  it("returns the conservative default when no env override is set", () => {
    expect(getMaxPaymentMinorUnits()).toBe(1_000_000);
    expect(getReviewThresholdMinorUnits()).toBe(200_000);
  });

  it("honors a valid positive-integer env override", () => {
    process.env.MAX_PAYMENT_MINOR_UNITS = "5000000";
    process.env.PAYMENT_REVIEW_THRESHOLD_MINOR_UNITS = "500000";
    expect(getMaxPaymentMinorUnits()).toBe(5_000_000);
    expect(getReviewThresholdMinorUnits()).toBe(500_000);
  });

  it("falls back to the default for a non-numeric, zero, or negative override rather than disabling the limit", () => {
    process.env.MAX_PAYMENT_MINOR_UNITS = "not-a-number";
    expect(getMaxPaymentMinorUnits()).toBe(1_000_000);
    process.env.MAX_PAYMENT_MINOR_UNITS = "0";
    expect(getMaxPaymentMinorUnits()).toBe(1_000_000);
    process.env.MAX_PAYMENT_MINOR_UNITS = "-100";
    expect(getMaxPaymentMinorUnits()).toBe(1_000_000);
  });
});
