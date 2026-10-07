import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("renders the approved Business-and-Personal hero", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /one platform\. business and personal\./i,
      }),
    ).toBeInTheDocument();
  });

  it("makes Business the primary CTA without removing Personal", () => {
    render(<HomePage />);

    expect(screen.getByRole("link", { name: /create business account/i })).toHaveAttribute(
      "href",
      "/signup?accountType=business",
    );

    const personalCtas = screen.getAllByRole("link", { name: /create personal account/i });
    expect(personalCtas.length).toBeGreaterThanOrEqual(1);
    for (const link of personalCtas) {
      expect(link).toHaveAttribute("href", "/signup?accountType=personal");
    }
  });

  it("shows the four launch industries", () => {
    render(<HomePage />);
    for (const label of ["Trucking", "Freight", "3PL", "Retail"]) {
      expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
    }
  });

  it("does not advertise deferred Business modules as live homepage capabilities", () => {
    render(<HomePage />);
    const bodyText = document.body.textContent ?? "";
    for (const deferred of ["Reconciliation", "Audit History", "Integrations"]) {
      expect(bodyText).not.toContain(deferred);
    }
  });
});