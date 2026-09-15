import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AccessibilityPage from "./page";

describe("AccessibilityPage", () => {
  it("identifies Paid2You correctly and states a real commitment", () => {
    render(<AccessibilityPage />);
    expect(screen.getByText(/paid2you is committed to providing an accessible experience/i)).toBeInTheDocument();
  });

  it("does not render the LegalPlaceholder banner", () => {
    render(<AccessibilityPage />);
    expect(screen.queryByText(/this page is a placeholder/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not yet finalized/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/in active development/i)).not.toBeInTheDocument();
  });

  it("does not expose internal compliance file names", () => {
    render(<AccessibilityPage />);
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("docs/");
    expect(bodyText).not.toContain(".md");
  });

  it("does not falsely claim WCAG/ADA conformance or certification", () => {
    render(<AccessibilityPage />);
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toMatch(/do not claim conformance/i);
    expect(bodyText).not.toMatch(/we (are|have been) (wcag|ada) certified/i);
    expect(bodyText).not.toMatch(/fully conformant/i);
  });

  it("points to the support page for accessibility feedback", () => {
    render(<AccessibilityPage />);
    expect(screen.getByRole("link", { name: /support/i })).toHaveAttribute("href", "/support");
  });

  it("does not use stale PAY2PAY branding", () => {
    render(<AccessibilityPage />);
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("PAY2PAY");
  });
});
