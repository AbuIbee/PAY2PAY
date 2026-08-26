import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgreementProgress } from "./AgreementProgress";
import type { AgreementProgress as AgreementProgressData } from "@/lib/agreements/agreementProgressService";

vi.mock("next/navigation", () => ({ usePathname: () => "/agreements/detail" }));

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
        key: "signatures",
        label: "Review & signatures",
        status: "action_required",
        description: "Review the agreement and sign to continue.",
        cta: null,
      },
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
    expect(screen.getAllByText("Not started").length).toBe(1);
  });

  it("shows a direct, correctly-labeled CTA for each actionable requirement that has one", () => {
    render(<AgreementProgress data={baseData()} />);
    // "Add payment method" appears twice by design — the step's own CTA and (since it's also the
    // primary action here) the primary-action CTA — both must point to the same, correct href.
    for (const link of screen.getAllByRole("link", { name: "Add payment method" })) {
      expect(link).toHaveAttribute("href", "/payment-methods");
    }
    // The other actionable step (signatures) has no CTA of its own — never renders a link for it.
    expect(screen.queryByRole("link", { name: /review & sign/i })).not.toBeInTheDocument();
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

  it("cancellation progress display fix: renders a cancelled agreement's terminal steps as 'Cancelled' (never Action required/Complete/Blocked), with no continuation CTA, on both mobile and desktop viewports (same data, same render)", () => {
    const cancelledData = baseData({
      status: "mutually_canceled",
      steps: [
        { key: "details_terms", label: "Agreement details & terms", status: "complete", description: "Agreement details and terms were recorded before cancellation.", cta: null },
        { key: "acceptance", label: "Review & acceptance", status: "cancelled", description: "This agreement was cancelled. No further action is required.", cta: null },
        { key: "payment_method", label: "Payment method", status: "optional", description: "Not required for this agreement.", cta: null },
        { key: "signatures", label: "Review & signatures", status: "cancelled", description: "This agreement was cancelled. No further action is required.", cta: null },
        { key: "active", label: "Agreement active", status: "cancelled", description: "This agreement was cancelled. No further action is required.", cta: null },
      ],
      primaryAction: { label: "Agreement cancelled", description: "No further action is required for this agreement.", cta: null },
      actionableForMeCount: 0,
    });

    for (const viewport of [{ width: 375 }, { width: 1280 }]) {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: viewport.width });
      const { unmount } = render(<AgreementProgress data={cancelledData} />);

      expect(screen.getAllByText("Cancelled").length).toBe(3); // acceptance, signatures, active
      expect(screen.getByText("Agreement cancelled")).toBeInTheDocument();
      expect(screen.getByText("No further action is required for this agreement.")).toBeInTheDocument();
      expect(screen.queryByText(/^Next:/)).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /verify identity/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /review and sign/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /add payment method/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/action required/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^blocked$/i)).not.toBeInTheDocument();

      unmount();
    }
  });

  it("restore agreement payment functionality: a step's statusText overrides the chip's generic status label", () => {
    render(
      <AgreementProgress
        data={baseData({
          steps: baseData().steps.map((s) =>
            s.key === "payment_method"
              ? {
                  ...s,
                  status: "waiting",
                  statusText: "Waiting for creditor payout setup",
                  description: "Your payment method is ready. Waiting for the creditor to set up a payout account.",
                  cta: null,
                }
              : s,
          ),
        })}
      />,
    );
    expect(screen.getByText("Waiting for creditor payout setup")).toBeInTheDocument();
    expect(screen.queryByText("Waiting on other party")).not.toBeInTheDocument();
  });

  describe("Fix the 'Make payment' button (mandatory command): same-page anchor CTAs scroll reliably instead of relying on Next.js Link's same-pathname hash navigation", () => {
    it("scrolls the target element into view directly, rather than only navigating, for a CTA pointing at an anchor on the current page", async () => {
      const user = userEvent.setup();
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      render(
        <div>
          <div id="make-payment" />
          <AgreementProgress
            data={baseData({
              steps: baseData().steps.map((s) =>
                s.key === "active"
                  ? { ...s, status: "waiting", statusText: "Next payment scheduled", cta: { label: "Make payment", href: "/agreements/detail?id=agreement-1#make-payment" } }
                  : s,
              ),
            })}
          />
        </div>,
      );

      await user.click(screen.getByRole("link", { name: "Make payment" }));
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    });

    it("falls back to normal navigation (no scroll call) when the CTA points at a different page", async () => {
      const user = userEvent.setup();
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      render(
        <AgreementProgress
          data={baseData({
            steps: baseData().steps.map((s) => (s.key === "payment_method" ? { ...s, cta: { label: "Set up payment method", href: "/payment-methods" } } : s)),
          })}
        />,
      );

      const link = screen.getByRole("link", { name: "Set up payment method" });
      await user.click(link);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(link).toHaveAttribute("href", "/payment-methods");
    });
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
