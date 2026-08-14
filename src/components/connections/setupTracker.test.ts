import { describe, expect, it } from "vitest";
import { buildSetupSteps } from "./setupTracker";

describe("buildSetupSteps", () => {
  it("marks every step incomplete when every prerequisite reason is present", () => {
    const steps = buildSetupSteps(
      ["counterparty_missing", "agreement_missing", "funding_account_missing", "payout_account_missing"],
      "invited",
    );
    expect(steps.every((s) => !s.complete)).toBe(true);
  });

  it("marks every step complete once no reasons remain and status is active — driven entirely by the inputs, not any internal/inferred state", () => {
    const steps = buildSetupSteps([], "active");
    expect(steps.every((s) => s.complete)).toBe(true);
  });

  it("the final 'Relationship active' step is driven by relationship status, not by reasons alone", () => {
    // Zero reasons (eligible to activate) but not yet activated — every step except the last is complete.
    const steps = buildSetupSteps([], "signed");
    expect(steps.find((s) => s.label === "Signatures complete")?.complete).toBe(true);
    expect(steps.find((s) => s.label === "Relationship active")?.complete).toBe(false);
  });

  it("treats a mandate/card verification gap as funding not ready, independent of the funding account itself existing", () => {
    const steps = buildSetupSteps(["mandate_missing"], "financial_setup_pending");
    expect(steps.find((s) => s.label === "Funding account ready")?.complete).toBe(false);
  });

  it("re-evaluates fully from a fresh reasons array each call — no memory of a previous call's result", () => {
    const blocked = buildSetupSteps(["signature_missing"], "agreement_pending");
    expect(blocked.find((s) => s.label === "Signatures complete")?.complete).toBe(false);
    const unblocked = buildSetupSteps([], "signed");
    expect(unblocked.find((s) => s.label === "Signatures complete")?.complete).toBe(true);
  });
});
