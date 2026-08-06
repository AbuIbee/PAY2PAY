import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("renders the PAY2PAY heading and foundation-scope messaging", () => {
    render(<HomePage />);
    expect(screen.getByRole("heading", { level: 1, name: "PAY2PAY" })).toBeInTheDocument();
    expect(screen.getByText(/not implemented yet/i)).toBeInTheDocument();
  });
});
