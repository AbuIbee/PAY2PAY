import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoWalkthrough } from "./DemoWalkthrough";

/**
 * Section R/S (closed-beta remediation, Product Owner review): a public, no-signup demo using seeded
 * fictional data only. These tests prove it makes zero network calls (a bug here would mean real
 * production data/APIs leaking into a page anyone can load without an account) and that step
 * navigation works for each of the 4 required scenarios.
 */
describe("DemoWalkthrough", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never calls fetch — every scenario is fixture data only", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DemoWalkthrough />);
    await user.click(screen.getByRole("button", { name: /personal repayment/i }));
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await user.click(screen.getByRole("button", { name: /^back$/i }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a persistent DEMO banner", () => {
    render(<DemoWalkthrough />);
    expect(screen.getByText(/DEMO — No real money or accounts are being used\./i)).toBeInTheDocument();
  });

  it("offers all 4 required scenarios: P2P, C2B, B2B, and a dashboard tour", () => {
    render(<DemoWalkthrough />);
    expect(screen.getByText("Fatimah owes Aminah $1,200")).toBeInTheDocument();
    expect(screen.getByText("Jaleel pays Prestiege Apartments $2,000/mo rent")).toBeInTheDocument();
    expect(screen.getByText("Mary's Mechanic Shop pays Adam's Auto Parts $3,500/mo")).toBeInTheDocument();
    expect(screen.getByText("A guided look at your dashboard")).toBeInTheDocument();
  });

  it("steps forward and backward through a scenario, disabling Back on the first step", async () => {
    const user = userEvent.setup();
    render(<DemoWalkthrough />);

    await user.click(screen.getByRole("button", { name: /personal repayment/i }));
    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^back$/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Step 2 of 5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^back$/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /^back$/i }));
    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();
  });

  it("replaces Next with a real signup link on the final step of a scenario", async () => {
    const user = userEvent.setup();
    render(<DemoWalkthrough />);

    await user.click(screen.getByRole("button", { name: /personal repayment/i }));
    for (let i = 0; i < 4; i += 1) {
      await user.click(screen.getByRole("button", { name: /^next$/i }));
    }

    expect(screen.getByText("Step 5 of 5")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^next$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create your own agreement/i })).toHaveAttribute("href", "/signup");
  });

  it("returns to the scenario picker via 'Choose a different scenario'", async () => {
    const user = userEvent.setup();
    render(<DemoWalkthrough />);

    await user.click(screen.getByRole("button", { name: /personal repayment/i }));
    await user.click(screen.getByRole("button", { name: /choose a different scenario/i }));

    expect(screen.getByText("Fatimah owes Aminah $1,200")).toBeInTheDocument();
    expect(screen.queryByText(/step \d of \d/i)).not.toBeInTheDocument();
  });
});
