import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { addFrequencyInterval, computeSchedule } from "./schedule";

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
