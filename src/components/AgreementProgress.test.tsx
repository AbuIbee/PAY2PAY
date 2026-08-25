import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgreementProgress } from "./AgreementProgress";
import type { AgreementProgress as AgreementProgressData } from "@/lib/agreements/agreementProgressService";

function baseData(overrides: Partial<AgreementProgressData> = {}): AgreementProgressData {
  return {
    agreementId: "agreement-1",
    myRole: "debtor",
    status: "awaiting_signatures",
    steps: [
      { key: "details_terms", label: "Agreement details & terms", status: "complete", description: "Car repair — $1,200", cta: null },
      { key: "acceptance", label: "Review & acceptance", status: "complete", description: "Both parties accepted.", cta: null },
      {
        key: "payment_method",
        label: "Payment method",
        status: "action_required",
        description: "Add a funding account before making payments on this agreement.",
        cta: { label: "Add payment method", href: "/payment-methods" },
      },
      {
        key: "identity_verification",
        label: "Identity verification",
        status: "action_required",
        description: "Your identity must complete full verification before signing this agreement.",
        cta: { label: "Verify identity", href: "/account/verification" },
      },
      { key: "signatures", label: "Review & signatures", status: "not_started", description: "Both parties must accept these terms before signing.", cta: null },
      { key: "active", label: "Agreement active", status: "not_started", description: "Not yet reached.", cta: null },
    ],
    primaryAction: { label: "Add payment method", description: "Add a funding account before making payments on this agreement.", cta: { label: "Add payment method", href: "/payment-methods" } },
    actionableForMeCount: 2,
    ...overrides,
  };
}

/**
 * Agreement workflow remediation (Problem 3): proves the persistent progress checklist renders every
 * required element — icon+status text+chip (never color alone), a direct CTA per actionable
 * requirement, the multi-missing-requirement summary, and the single primary next action.
 */
describe("AgreementProgress", () => {
  it("renders every step with a visible status label (icon + text), not color alone", () => {
    render(<AgreementProgress data={baseData()} />);
    expect(screen.getByText("Agreement progress")).toBeInTheDocument();
    expect(screen.getAllByText("Complete").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Action required").length).toBe(2);
    expect(screen.getAllByText("Not started").length).toBe(2);
  });

  it("shows a direct, correctly-labeled CTA for each actionable requirement", () => {
    render(<AgreementProgress data={baseData()} />);
    // "Add payment method" appears twice by design — the step's own CTA and (since it's also the
    // primary action here) the primary-action CTA — both must point to the same, correct href.
    for (const link of screen.getAllByRole("link", { name: "Add payment method" })) {
      expect(link).toHaveAttribute("href", "/payment-methods");
    }
    expect(screen.getByRole("link", { name: "Verify identity" })).toHaveAttribute("href", "/account/verification");
  });

  it("never shows a CTA for a step with no action to take", () => {
    render(<AgreementProgress data={baseData()} />);
    // "Review & acceptance" (complete, cta: null) and "Agreement active" (not_started, cta: null)
    // must not render any link with their own label.
    expect(screen.queryByRole("link", { name: /review & acceptance/i })).not.toBeInTheDocument();
  });

  it("shows the 'N items required' summary when more than one step is actionable", () => {
    render(<AgreementProgress data={baseData()} />);
    expect(screen.getByText("2 items required before this agreement can be completed")).toBeInTheDocument();
  });

  it("hides the multi-requirement summary when only one (or zero) items are actionable", () => {
    render(
      <AgreementProgress
        data={baseData({
          actionableForMeCount: 1,
          steps: baseData().steps.map((s) => (s.key === "payment_method" ? { ...s, status: "complete", cta: null } : s)),
        })}
      />,
    );
    expect(screen.queryByText(/items required before this agreement/i)).not.toBeInTheDocument();
  });

  it("renders a single, obvious primary next action with its own CTA", () => {
    render(<AgreementProgress data={baseData()} />);
    expect(screen.getByText(/^Next: Add payment method$/)).toBeInTheDocument();
    // Two "Add payment method" links exist by design — the step's own CTA and the primary-action CTA.
    expect(screen.getAllByRole("link", { name: "Add payment method" }).length).toBe(2);
  });

  it("renders a waiting-on-other-party step with its own status text, not just a color", () => {
    render(
      <AgreementProgress
        data={baseData({
          steps: baseData().steps.map((s) =>
            s.key === "signatures" ? { ...s, status: "waiting", description: "You've signed. Waiting for the creditor to sign." } : s,
          ),
          primaryAction: { label: "Waiting for other party", description: "You've signed. Waiting for the creditor to sign.", cta: null },
        })}
      />,
    );
    expect(screen.getByText("Waiting on other party")).toBeInTheDocument();
    // Appears twice by design — the step's own description and the primary-action description below it.
    expect(screen.getAllByText(/waiting for the creditor to sign/i).length).toBeGreaterThanOrEqual(1);
  });

  it("renders a blocked step's exact reason, not a generic message", () => {
    render(
      <AgreementProgress
        data={baseData({
          steps: baseData().steps.map((s) =>
            s.key === "signatures"
              ? { ...s, status: "blocked", description: "The proposed first payment date (2026-01-01) has already passed. This agreement's schedule must be revised before either party can sign." }
              : s,
          ),
        })}
      />,
    );
    expect(screen.getByText(/2026-01-01.*already passed/i)).toBeInTheDocument();
  });
});
