import { describe, expect, it } from "vitest";
import {
  agreementStatusLabel,
  appealDecisionLabel,
  relationshipStatusLabel,
  settlementProposalStatusLabel,
} from "./statusLabels";

describe("statusLabels registries", () => {
  it("never leaks a raw enum string for a known value", () => {
    expect(agreementStatusLabel("awaiting_debtor_acknowledgment")).toEqual({
      label: "Awaiting acknowledgment",
      tone: "info",
    });
    expect(relationshipStatusLabel("counterparty_linked").label).toBe("Connected");
  });

  it("falls back to the raw value (not a crash) for an unrecognized status, so a future backend value never breaks rendering", () => {
    // @ts-expect-error deliberately passing a value outside the known union to exercise the fallback
    expect(agreementStatusLabel("some_future_status")).toEqual({ label: "some_future_status", tone: "neutral" });
  });

  it("keeps 'accepted' and 'completed' visually distinct for settlements — the spec's hard rule", () => {
    const accepted = settlementProposalStatusLabel("awaiting_payment");
    const completed = settlementProposalStatusLabel("completed");
    expect(accepted.label).not.toBe(completed.label);
    expect(accepted.tone).not.toBe(completed.tone);
    expect(accepted.label.toLowerCase()).not.toContain("completed");
    expect(accepted.label.toLowerCase()).not.toContain("paid");
  });

  it("every StatusLabel carries a non-empty label so a chip is never color-only", () => {
    for (const value of ["upheld", "overturned", "partially_overturned"] as const) {
      expect(appealDecisionLabel(value).label.length).toBeGreaterThan(0);
    }
  });
});
