import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("renders the hero heading", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /one account\. business and personal\./i,
      }),
    ).toBeInTheDocument();
  });

  it(
    "Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md): no longer presents " +
      "an early-access / in-active-development landing section",
    () => {
      render(<HomePage />);
      expect(screen.queryByText(/get on the early-access list/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/in active development/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("form", { name: /early access/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/joining early access does not create an account/i)).not.toBeInTheDocument();
    },
  );

  it("does not present the product as a sandbox or development demo", () => {
    render(<HomePage />);
    const bodyText = document.body.textContent ?? "";
    expect(bodyText.toLowerCase()).not.toContain("sandbox");
    expect(bodyText.toLowerCase()).not.toContain("test payment");
    expect(bodyText.toLowerCase()).not.toContain("development-only");
  });

  it("never claims Paid2You lends money, guarantees repayment, or uses Adyen", () => {
    render(<HomePage />);
    const bodyText = (document.body.textContent ?? "").toLowerCase();
    expect(bodyText).not.toContain("adyen");
    expect(bodyText).not.toMatch(/paid2you lends/);
    expect(bodyText).not.toMatch(/guarantee(s|d)? repayment/);
  });

  it("truthfully labels not-yet-available Business capabilities as Coming soon, never as live", () => {
    const { container } = render(<HomePage />);
    const businessList = container.querySelector(".workspace-card--business .workspace-card__list");
    expect(businessList).not.toBeNull();
    for (const label of ["Payments", "Reports", "Reconciliation", "Documents", "Audit History", "Integrations"]) {
      const comingSoonItem = Array.from(businessList!.querySelectorAll("li")).find((li) => li.textContent?.includes(label));
      expect(comingSoonItem).toBeTruthy();
      expect(comingSoonItem).toHaveTextContent(/coming soon/i);
      expect(comingSoonItem?.querySelector(".workspace-check")).toBeNull();
    }
  });

  it("presents exactly the live Business nav destinations as available", () => {
    const { container } = render(<HomePage />);
    const businessList = container.querySelector(".workspace-card--business .workspace-card__list");
    expect(businessList).not.toBeNull();
    for (const label of [
      "Dashboard",
      "Outstanding Balances",
      "Customers",
      "Agreements",
      "Employees",
      "Organization Settings",
      "Billing & Subscription",
    ]) {
      const liveItem = Array.from(businessList!.querySelectorAll("li")).find((li) => li.textContent?.includes(label));
      expect(liveItem).toBeTruthy();
      expect(liveItem).not.toHaveTextContent(/coming soon/i);
      expect(liveItem?.querySelector(".workspace-check")).not.toBeNull();
    }
  });

  it("routes the hero CTAs into the real signup flow with the correct account type", () => {
    render(<HomePage />);
    expect(screen.getByRole("link", { name: /create business account/i })).toHaveAttribute(
      "href",
      "/signup?accountType=business",
    );
    expect(screen.getByRole("link", { name: /create personal account/i })).toHaveAttribute(
      "href",
      "/signup?accountType=personal",
    );
  });

  it("marks the hero product visual's sample data as illustrative only", () => {
    render(<HomePage />);
    expect(screen.getByText(/example data shown for illustration only/i)).toBeInTheDocument();
  });
});
