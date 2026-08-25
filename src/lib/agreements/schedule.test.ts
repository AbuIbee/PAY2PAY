import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { addFrequencyInterval, computeSchedule, isPastDate } from "./schedule";

describe("computeSchedule", () => {
  it("schedule arithmetic: evenly-divisible balance produces equal installments and the right count", () => {
    const result = computeSchedule({
      currentPrincipalMinorUnits: 120_000, // $1,200.00
      firstPaymentMinorUnits: 20_000, // $200.00
      installmentAmountMinorUnits: 20_000, // $200.00
      frequency: "monthly",
      firstPaymentDate: "2026-01-15",
    });
    // remaining = 100,000 / 20,000 = exactly 5 installments
    expect(result.numberOfInstallments).toBe(5);
    expect(result.items).toHaveLength(6); // first payment + 5 installments
    expect(result.items.slice(1).every((item) => item.amountMinorUnits === 20_000)).toBe(true);
    expect(result.finalPaymentMinorUnits).toBe(20_000);
    expect(result.items[0]).toEqual({ sequenceNumber: 0, dueDate: "2026-01-15", amountMinorUnits: 20_000 });
    expect(result.items[1]?.dueDate).toBe("2026-02-15");
    expect(result.items[5]?.dueDate).toBe("2026-06-15");
  });

  it("rounding: an unevenly-divisible balance absorbs the remainder entirely into the final installment", () => {
    const result = computeSchedule({
      currentPrincipalMinorUnits: 100_000,
      firstPaymentMinorUnits: 0,
      installmentAmountMinorUnits: 30_000,
      frequency: "weekly",
      firstPaymentDate: "2026-01-01",
    });
    // remaining = 100,000; 100,000 / 30,000 = 3.33 -> ceil = 4 installments
    expect(result.numberOfInstallments).toBe(4);
    const laterInstallments = result.items.slice(1);
    expect(laterInstallments).toHaveLength(4);
    expect(laterInstallments.slice(0, 3).every((item) => item.amountMinorUnits === 30_000)).toBe(true);
    // 100,000 - 30,000*3 = 10,000 — the uneven remainder, not a hidden fee, not silently dropped.
    expect(result.finalPaymentMinorUnits).toBe(10_000);
    const total = result.items.reduce((sum, item) => sum + item.amountMinorUnits, 0);
    expect(total).toBe(100_000); // every minor unit accounted for, nothing lost or invented.
  });

  it("a first payment that exactly clears the principal produces zero later installments", () => {
    const result = computeSchedule({
      currentPrincipalMinorUnits: 50_000,
      firstPaymentMinorUnits: 50_000,
      installmentAmountMinorUnits: 10_000,
      frequency: "monthly",
      firstPaymentDate: "2026-03-01",
    });
    expect(result.numberOfInstallments).toBe(0);
    expect(result.items).toHaveLength(1);
    expect(result.finalPaymentMinorUnits).toBe(50_000);
  });

  it("rejects a first payment greater than the current principal", () => {
    expect(() =>
      computeSchedule({
        currentPrincipalMinorUnits: 10_000,
        firstPaymentMinorUnits: 20_000,
        installmentAmountMinorUnits: 5_000,
        frequency: "monthly",
        firstPaymentDate: "2026-01-01",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a non-positive installment amount when later installments are needed", () => {
    expect(() =>
      computeSchedule({
        currentPrincipalMinorUnits: 10_000,
        firstPaymentMinorUnits: 0,
        installmentAmountMinorUnits: 0,
        frequency: "monthly",
        firstPaymentDate: "2026-01-01",
      }),
    ).toThrow(ValidationError);
  });

  it("weekly/biweekly date math adds exact day counts", () => {
    expect(addFrequencyInterval("2026-01-01", "weekly", 1)).toBe("2026-01-08");
    expect(addFrequencyInterval("2026-01-01", "weekly", 3)).toBe("2026-01-22");
    expect(addFrequencyInterval("2026-01-01", "biweekly", 1)).toBe("2026-01-15");
    expect(addFrequencyInterval("2026-01-01", "biweekly", 2)).toBe("2026-01-29");
  });

  it("monthly date math clamps to the target month's last day instead of rolling over", () => {
    // Jan 31 + 1 month must land on Feb 28 (2026 is not a leap year), not roll into March.
    expect(addFrequencyInterval("2026-01-31", "monthly", 1)).toBe("2026-02-28");
    // Dec 31 + 1 month crosses a year boundary correctly.
    expect(addFrequencyInterval("2025-12-31", "monthly", 1)).toBe("2026-01-31");
    // A leap-year February is handled correctly.
    expect(addFrequencyInterval("2028-01-31", "monthly", 1)).toBe("2028-02-29");
  });

  it("a zero-principal schedule (debt already fully settled by prior payments) produces a single zero-amount first payment and no later installments", () => {
    const result = computeSchedule({
      currentPrincipalMinorUnits: 0,
      firstPaymentMinorUnits: 0,
      installmentAmountMinorUnits: 10_000,
      frequency: "monthly",
      firstPaymentDate: "2026-01-01",
    });
    expect(result.numberOfInstallments).toBe(0);
    expect(result.items).toEqual([{ sequenceNumber: 0, dueDate: "2026-01-01", amountMinorUnits: 0 }]);
    expect(result.finalPaymentMinorUnits).toBe(0);
  });

  it(
    "PRSprint 17 (docs/prsprints/PRSPRINT_17_PAYMENT_SCHEDULE_MONETARY_MATH.md): rejects an unsafe " +
      "integer amount (beyond Number.MAX_SAFE_INTEGER) rather than silently computing with a value " +
      "that cannot be trusted to add/subtract/compare exactly",
    () => {
      const unsafe = Number.MAX_SAFE_INTEGER + 2; // still Number.isInteger(unsafe) === true
      expect(() =>
        computeSchedule({
          currentPrincipalMinorUnits: unsafe,
          firstPaymentMinorUnits: 0,
          installmentAmountMinorUnits: 10_000,
          frequency: "monthly",
          firstPaymentDate: "2026-01-01",
        }),
      ).toThrow(ValidationError);
      expect(() =>
        computeSchedule({
          currentPrincipalMinorUnits: 10_000,
          firstPaymentMinorUnits: 0,
          installmentAmountMinorUnits: unsafe,
          frequency: "monthly",
          firstPaymentDate: "2026-01-01",
        }),
      ).toThrow(ValidationError);
    },
  );

  it("rejects a non-integer (fractional-cent) amount — the schema's own integer-minor-units invariant, enforced at the boundary, not merely by column type", () => {
    expect(() =>
      computeSchedule({
        currentPrincipalMinorUnits: 10_000.5,
        firstPaymentMinorUnits: 0,
        installmentAmountMinorUnits: 1_000,
        frequency: "monthly",
        firstPaymentDate: "2026-01-01",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an invalid firstPaymentDate", () => {
    expect(() =>
      computeSchedule({
        currentPrincipalMinorUnits: 10_000,
        firstPaymentMinorUnits: 0,
        installmentAmountMinorUnits: 1_000,
        frequency: "monthly",
        firstPaymentDate: "not-a-date",
      }),
    ).toThrow(ValidationError);
  });
});

describe("isPastDate", () => {
  // Fixed reference instant — Wed Aug 12 2026 (UTC) — so these assertions never depend on the real
  // clock (agreement workflow remediation, Problem 2).
  const NOW_MS = Date.UTC(2026, 7, 12, 15, 0, 0);

  it("returns true for a date strictly before today (UTC)", () => {
    expect(isPastDate("2026-08-11", NOW_MS)).toBe(true);
    expect(isPastDate("2026-01-01", NOW_MS)).toBe(true);
  });

  it("returns false for today itself", () => {
    expect(isPastDate("2026-08-12", NOW_MS)).toBe(false);
  });

  it("returns false for a future date", () => {
    expect(isPastDate("2026-08-13", NOW_MS)).toBe(false);
    expect(isPastDate("2027-01-01", NOW_MS)).toBe(false);
  });

  it("compares whole UTC calendar days, not exact instants — late-in-the-day 'now' still treats today as not-past", () => {
    const lateInDay = Date.UTC(2026, 7, 12, 23, 59, 59);
    expect(isPastDate("2026-08-12", lateInDay)).toBe(false);
  });
});
