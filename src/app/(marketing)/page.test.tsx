import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("renders the hero heading", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /turn an obligation into a plan both sides can trust/i,
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

  it("states the platform is not a lender or guarantor", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", {
        name: /a repayment platform—not a lender, collector, or guarantor/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows all four relationship types", () => {
    render(<HomePage />);
    // Each tag appears more than once (proof strip, product-preview mockup,
    // and the relationship-shape cards), so assert presence rather than a
    // single unique match — same convention as MobileNavToggle.test.tsx.
    expect(screen.getAllByText("P2P").length).toBeGreaterThan(0);
    expect(screen.getAllByText("B2C").length).toBeGreaterThan(0);
    expect(screen.getAllByText("C2B").length).toBeGreaterThan(0);
    expect(screen.getAllByText("B2B").length).toBeGreaterThan(0);
  });
});
