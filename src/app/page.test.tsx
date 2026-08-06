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

  it("does not claim agreements or payments are live", () => {
    render(<HomePage />);
    expect(
      screen.getByText(/account creation, agreements, signatures, and payments are not yet enabled/i),
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
    expect(screen.getByText("P2P")).toBeInTheDocument();
    expect(screen.getByText("B2C")).toBeInTheDocument();
    expect(screen.getByText("C2B")).toBeInTheDocument();
    expect(screen.getByText("B2B")).toBeInTheDocument();
  });
});
