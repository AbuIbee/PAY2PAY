import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { P2PDemo } from "./P2PDemo";

/**
 * Demo navigation & dedicated demo experiences (Product Owner request): P2P Demo — proves the exact
 * required journey (invitation -> acceptance -> agreement -> signing -> payment method -> $250
 * partial payment -> $750 remaining -> subsequent payments -> paid in full), the
 * exact required safety banner text, and — most importantly — that this page makes zero network
 * calls (fixture data only, no real invitations/agreements/payments/customer data), mirroring
 * DemoWalkthrough.test.tsx's identical "never calls fetch" contract.
 */
describe("P2PDemo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never calls fetch — every step is fixture data only", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<P2PDemo />);
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await user.click(screen.getByRole("button", { name: /^back$/i }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the exact required DEMO safety banner", () => {
    render(<P2PDemo />);
    expect(screen.getByText("DEMO — No real money or customer data is being used.")).toBeInTheDocument();
  });

  it("walks the full required P2P journey in order: invitation, acceptance, agreement, signing, payment method, $250 partial payment, $750 remaining, subsequent payments, paid in full", async () => {
    const user = userEvent.setup();
    render(<P2PDemo />);

    expect(screen.getByText("Step 1 of 9")).toBeInTheDocument();
    expect(screen.getByText("The situation")).toBeInTheDocument();
    expect(screen.getAllByText(/person a owes person b \$1,000/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Connection invitation")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Acceptance")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Repayment agreement")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Signing")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Payment method")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("First payment — $250")).toBeInTheDocument();
    expect(screen.getByText("$750")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Subsequent payments")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByRole("heading", { name: "Paid in full" })).toBeInTheDocument();
    expect(screen.getByText("Step 9 of 9")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^next$/i })).not.toBeInTheDocument();
  });

  it("offers a way back to the general demo landing page", () => {
    render(<P2PDemo />);
    expect(screen.getByRole("link", { name: /all demos/i })).toHaveAttribute("href", "/demo");
  });
});
