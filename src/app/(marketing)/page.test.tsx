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

  it("truthfully states agreements and payments are live for signed-up users", () => {
    render(<HomePage />);
    expect(
      screen.getByText(/account creation, agreements, signatures, and payments are live for signed-up users/i),
    ).toBeInTheDocument();
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
