import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("renders the hero heading", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /turn what.s owed into a documented, signed repayment plan/i,
      }),
    ).toBeInTheDocument();
  });

  it("does not claim agreements or payments are live", () => {
    render(<HomePage />);
    expect(screen.getByText(/no accounts, agreements, signatures, or payments are functional yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /not yet available/i })).toBeDisabled();
  });

  it("states the platform is not a lender or fund custodian", () => {
    render(<HomePage />);
    expect(screen.getByText(/not a lender, and not in the business of advancing loan proceeds/i)).toBeInTheDocument();
  });
});
