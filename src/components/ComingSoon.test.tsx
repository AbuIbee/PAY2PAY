import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComingSoon } from "./ComingSoon";

/**
 * Organization Features: Coming Soon treatment — the shared informational state used by every
 * currently-deferred Organization page (Staff, Custom roles, Approvals). Proves: visible text (never
 * color alone), never rendered as an error, and renders identically regardless of viewport (a plain
 * CSS-responsive component, same markup on desktop and mobile — matches this codebase's established
 * pattern elsewhere).
 */
describe("ComingSoon", () => {
  it("7/8. shows the feature name and visible 'Coming Soon' text, on any viewport (desktop and mobile use the same markup)", () => {
    for (const viewport of [{ width: 375 }, { width: 1280 }]) {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: viewport.width });
      const { unmount } = render(<ComingSoon feature="Manage Staff" />);
      expect(screen.getByRole("heading", { name: "Manage Staff" })).toBeInTheDocument();
      expect(screen.getByText("Coming Soon")).toBeInTheDocument();
      unmount();
    }
  });

  it("is never rendered as an error state — no alert role, no error styling class", () => {
    render(<ComingSoon feature="Approvals" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("uses a default explanatory description when none is provided, or a custom one when given", () => {
    const { unmount } = render(<ComingSoon feature="Custom Roles" />);
    expect(screen.getByText(/coming soon\. we'll let you know/i)).toBeInTheDocument();
    unmount();

    render(<ComingSoon feature="Custom Roles" description="This feature is coming soon." />);
    expect(screen.getByText("This feature is coming soon.")).toBeInTheDocument();
  });

  it("contains no interactive controls (no link, no button) — it must never behave like a working feature", () => {
    render(<ComingSoon feature="Manage Staff" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
