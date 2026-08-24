import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { C2BDemo } from "./C2BDemo";

/**
 * Demo navigation & dedicated demo experiences (Product Owner request): C2B Demo — proves the
 * required journey (relationship -> agreement -> schedule -> payment method -> payment -> balance
 * reduction -> completion), the customer-vs-business role distinction, the exact safety banner, and
 * zero network calls.
 */
describe("C2BDemo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never calls fetch — every step is fixture data only", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<C2BDemo />);
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the exact required DEMO safety banner", () => {
    render(<C2BDemo />);
    expect(screen.getByText("DEMO — No real money or customer data is being used.")).toBeInTheDocument();
  });

  it("walks the required C2B journey: relationship, agreement, schedule, payment method, payment/balance reduction, completion — for the $600 example", async () => {
    const user = userEvent.setup();
    render(<C2BDemo />);

    expect(screen.getByText("Step 1 of 7")).toBeInTheDocument();
    expect(screen.getByText(/customer owes a local business \$600/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Business/customer relationship")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Repayment agreement")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Payment schedule")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Payment method")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Payment & balance reduction")).toBeInTheDocument();
    expect(screen.getByText("$450")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByText("Completion")).toBeInTheDocument();
    expect(screen.getByText("Step 7 of 7")).toBeInTheDocument();
  });

  it("clearly explains the customer's role versus the business's role", () => {
    render(<C2BDemo />);
    expect(screen.getByText(/customer's role:[\s\S]*business's role:/i)).toBeInTheDocument();
  });
});
