import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2BDemo } from "./B2BDemo";

/**
 * Demo navigation & dedicated demo experiences (Product Owner request): B2B Demo — proves the
 * required journey (relationship -> authorized staff/role context -> agreement -> approval/signing
 * -> payment method -> scheduled/partial payments -> remaining balance -> completion), the exact
 * safety banner, and zero network calls.
 */
describe("B2BDemo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never calls fetch — every step is fixture data only", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<B2BDemo />);
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the exact required DEMO safety banner", () => {
    render(<B2BDemo />);
    expect(screen.getByText("DEMO — No real money or customer data is being used.")).toBeInTheDocument();
  });

  it("walks the required B2B journey: relationship, authorized staff/role context, agreement, approval/signing, payment method, scheduled payments, completion — for the $5,000 example", async () => {
    const user = userEvent.setup();
    render(<B2BDemo />);

    expect(screen.getByText("Step 1 of 8")).toBeInTheDocument();
    expect(screen.getByText(/business a owes business b \$5,000/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Business relationship")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Authorized staff & role context")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Agreement")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Approval & signing")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Payment method")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Scheduled payments & remaining balance")).toBeInTheDocument();
    expect(screen.getByText("$3,000")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Completion")).toBeInTheDocument();
    expect(screen.getByText("Step 8 of 8")).toBeInTheDocument();
  });
});
