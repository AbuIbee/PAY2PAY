import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductTour } from "./ProductTour";

const AREAS = [
  "Dashboard",
  "Connections",
  "Payment Arrangements",
  "My Cash",
  "Payment Methods",
  "Notifications",
  "Support",
  "Settings",
  "Security",
  "Verification",
  "Staff & Organization",
];

/**
 * Demo navigation & dedicated demo experiences (Product Owner request): Product Tour — proves all
 * 11 required areas are covered, each with a "what it's for / what you can do / what's next"
 * explanation, Next/Back/Exit Tour controls, a "Step X of Y" progress indicator, and zero network
 * calls (no test data needs to be created to complete the tour).
 */
describe("ProductTour", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never calls fetch — the tour requires no test data to be created", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ProductTour />);
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await user.click(screen.getByRole("button", { name: /^back$/i }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the exact required DEMO safety banner", () => {
    render(<ProductTour />);
    expect(screen.getByText("DEMO — No real money or customer data is being used.")).toBeInTheDocument();
  });

  it("covers all 11 required areas in order, each with a progress indicator and what-it's-for / what-you-can-do / what's-next explanation", async () => {
    const user = userEvent.setup();
    render(<ProductTour />);

    for (let i = 0; i < AREAS.length; i += 1) {
      expect(screen.getByText(`Step ${i + 1} of ${AREAS.length}`)).toBeInTheDocument();
      expect(screen.getAllByText(AREAS[i]!).length).toBeGreaterThan(0);
      expect(screen.getByText(/what it.?s for:/i)).toBeInTheDocument();
      expect(screen.getByText(/what you can do here:/i)).toBeInTheDocument();
      expect(screen.getByText(/what normally comes next:/i)).toBeInTheDocument();
      if (i < AREAS.length - 1) {
        await user.click(screen.getByRole("button", { name: /^next$/i }));
      }
    }
    expect(screen.queryByRole("button", { name: /^next$/i })).not.toBeInTheDocument();
  });

  it("provides a Back control, disabled on the first step and enabled after advancing", async () => {
    const user = userEvent.setup();
    render(<ProductTour />);

    expect(screen.getByRole("button", { name: /^back$/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByRole("button", { name: /^back$/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /^back$/i }));
    expect(screen.getByText("Step 1 of 11")).toBeInTheDocument();
  });

  it("provides an explicit Exit Tour control", () => {
    render(<ProductTour />);
    expect(screen.getByRole("link", { name: /exit tour/i })).toHaveAttribute("href", "/demo");
  });
});
