import { afterEach, describe, expect, it } from "vitest";
import {
  getDailyAmountLimitMinorUnits,
  getDailyAttemptCountLimit,
  getMaxPaymentMinorUnits,
  getReviewThresholdMinorUnits,
  summarizeRecentActivity,
} from "./transactionLimits";

describe("transactionLimits", () => {
  afterEach(() => {
    delete process.env.MAX_PAYMENT_MINOR_UNITS;
    delete process.env.PAYMENT_REVIEW_THRESHOLD_MINOR_UNITS;
    delete process.env.DAILY_PAYMENT_AMOUNT_LIMIT_MINOR_UNITS;
    delete process.env.DAILY_PAYMENT_ATTEMPT_COUNT_LIMIT;
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

  describe("SPRINT_19_FraudRisk_SecurityHardening: daily amount/count limits", () => {
    it("returns the conservative default when no env override is set", () => {
      expect(getDailyAmountLimitMinorUnits()).toBe(5_000_000);
      expect(getDailyAttemptCountLimit()).toBe(20);
    });

    it("honors a valid positive-integer env override", () => {
      process.env.DAILY_PAYMENT_AMOUNT_LIMIT_MINOR_UNITS = "1000000";
      process.env.DAILY_PAYMENT_ATTEMPT_COUNT_LIMIT = "5";
      expect(getDailyAmountLimitMinorUnits()).toBe(1_000_000);
      expect(getDailyAttemptCountLimit()).toBe(5);
    });
  });

  describe("summarizeRecentActivity", () => {
    it("sums amount only for statuses that moved or could still move money, but counts every attempt", () => {
      const records = [
        { status: "succeeded", amountMinorUnits: 1_000 },
        { status: "processing", amountMinorUnits: 2_000 },
        { status: "failed", amountMinorUnits: 5_000 },
        { status: "canceled", amountMinorUnits: 7_000 },
      ];
      const summary = summarizeRecentActivity(records);
      expect(summary.amountMinorUnits).toBe(3_000); // only succeeded + processing
      expect(summary.attemptCount).toBe(4); // every attempt, including failed/canceled
    });

    it("returns zero for no recent activity", () => {
      expect(summarizeRecentActivity([])).toEqual({ amountMinorUnits: 0, attemptCount: 0 });
    });
  });
});
