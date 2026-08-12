import { describe, expect, it } from "vitest";
import {
  computeBorrowerSurchargeMinorUnits,
  computeCardProcessorFeeMinorUnits,
  SANDBOX_ACH_PROCESSOR_FEE_MINOR_UNITS,
} from "./cardFeeAllocation";

describe("computeCardProcessorFeeMinorUnits", () => {
  it("computes a deterministic integer fee (2.9% + $0.30) for a $100 payment", () => {
    // 10_000 * 0.029 = 290, + 30 fixed = 320
    expect(computeCardProcessorFeeMinorUnits(10_000)).toBe(320);
  });

  it("is always an integer, never a fractional minor unit", () => {
    const fee = computeCardProcessorFeeMinorUnits(3_333);
    expect(Number.isInteger(fee)).toBe(true);
  });
});

describe("computeBorrowerSurchargeMinorUnits", () => {
  const cardFee = computeCardProcessorFeeMinorUnits(10_000); // 320

  it("fee allocation: creditor_pays absorbs the entire card fee — borrower surcharge is zero", () => {
    const surcharge = computeBorrowerSurchargeMinorUnits({
      feeAllocation: "creditor_pays",
      achEquivalentFeeMinorUnits: SANDBOX_ACH_PROCESSOR_FEE_MINOR_UNITS,
      cardProcessorFeeMinorUnits: cardFee,
    });
    expect(surcharge).toBe(0);
  });

  it("fee allocation: debtor_pays charges the borrower the full incremental card cost", () => {
    const surcharge = computeBorrowerSurchargeMinorUnits({
      feeAllocation: "debtor_pays",
      achEquivalentFeeMinorUnits: SANDBOX_ACH_PROCESSOR_FEE_MINOR_UNITS,
      cardProcessorFeeMinorUnits: cardFee,
    });
    expect(surcharge).toBe(cardFee - SANDBOX_ACH_PROCESSOR_FEE_MINOR_UNITS);
  });

  it("fee allocation: split_evenly still charges the borrower the full incremental cost (master spec's method-switch default overrides the general split for the increment specifically)", () => {
    const surcharge = computeBorrowerSurchargeMinorUnits({
      feeAllocation: "split_evenly",
      achEquivalentFeeMinorUnits: SANDBOX_ACH_PROCESSOR_FEE_MINOR_UNITS,
      cardProcessorFeeMinorUnits: cardFee,
    });
    expect(surcharge).toBe(cardFee - SANDBOX_ACH_PROCESSOR_FEE_MINOR_UNITS);
  });

  it("never returns a negative surcharge, even if a future ACH fee simulation exceeds the card fee", () => {
    const surcharge = computeBorrowerSurchargeMinorUnits({
      feeAllocation: "debtor_pays",
      achEquivalentFeeMinorUnits: 10_000,
      cardProcessorFeeMinorUnits: 320,
    });
    expect(surcharge).toBe(0);
  });
});
