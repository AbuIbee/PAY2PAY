import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MarketingLayout from "./layout";

describe("MarketingLayout (B0-A: header/footer branding)", () => {
  beforeEach(() => {
    // AuthNavCta fetches /api/auth/me on mount — stub it so it resolves instead of erroring in jsdom.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the current Paid2You brand in the header and footer, not the stale PAY2PAY name", () => {
    render(
      <MarketingLayout>
        <p>content</p>
      </MarketingLayout>,
    );
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("PAY2PAY");
    expect(screen.getByRole("link", { name: /paid2you home/i })).toBeInTheDocument();
    expect(screen.getByText(/© 2026 paid2you\./i)).toBeInTheDocument();
  });

  it("still links to all four footer legal/support pages", () => {
    render(
      <MarketingLayout>
        <p>content</p>
      </MarketingLayout>,
    );
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Support" })).toHaveAttribute("href", "/support");
    expect(screen.getByRole("link", { name: "Accessibility" })).toHaveAttribute("href", "/accessibility");
  });
});
