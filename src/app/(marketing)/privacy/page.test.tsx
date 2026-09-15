import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PrivacyPage from "./page";

describe("PrivacyPage (B0-A: internal-leak removal only, substantive content deferred to B0-C)", () => {
  it("no longer renders the docs/DATA_MODEL.md internal reference", () => {
    render(<PrivacyPage />);
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("docs/DATA_MODEL.md");
  });

  it("no longer renders the shared placeholder banner's internal COMPLIANCE_REVIEW_CHECKLIST reference", () => {
    render(<PrivacyPage />);
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("docs/COMPLIANCE_REVIEW_CHECKLIST.md");
    expect(bodyText).not.toContain("docs/");
  });

  it("was not otherwise rewritten this pass — the placeholder banner and pre-launch substance remain", () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/this page is a placeholder/i)).toBeInTheDocument();
    expect(screen.getByText(/pre-launch testing/i)).toBeInTheDocument();
    expect(screen.getByText(/none of this information is sold/i)).toBeInTheDocument();
  });
});
