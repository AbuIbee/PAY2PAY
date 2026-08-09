import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EarlyAccessForm } from "./EarlyAccessForm";

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^name$/i), "Jordan Rivera");
  await user.type(screen.getByLabelText(/^email$/i), "jordan@example.com");
  await user.selectOptions(screen.getByLabelText(/state/i), "CA");
  await user.type(screen.getByLabelText(/approx\. agreements per month/i), "3");
  await user.type(screen.getByLabelText(/intended use/i), "Repaying a friend.");
  await user.click(screen.getByLabelText(/i agree to be contacted/i));
}

describe("EarlyAccessForm", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "ok", id: "abc" }), { status: 201 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not show the business name field by default", () => {
    render(<EarlyAccessForm />);
    expect(screen.queryByLabelText(/business name/i)).not.toBeInTheDocument();
  });

  it("shows the business name field when business is selected, and it is required", async () => {
    const user = userEvent.setup();
    render(<EarlyAccessForm />);
    await user.click(screen.getByLabelText(/^business$/i));
    const businessNameField = screen.getByLabelText(/business name/i);
    expect(businessNameField).toBeRequired();
  });

  it("includes a honeypot field that is out of tab order and not labeled as required", () => {
    render(<EarlyAccessForm />);
    const honeypot = screen.getByLabelText(/website/i);
    expect(honeypot).toHaveAttribute("tabindex", "-1");
    expect(honeypot).not.toBeRequired();
  });

  it("never renders a field for bank account, SSN, EIN, card, or government ID", () => {
    render(<EarlyAccessForm />);
    const prohibited = [/bank account/i, /routing number/i, /social security/i, /\bssn\b/i, /\bein\b/i, /card number/i, /government id/i];
    for (const pattern of prohibited) {
      expect(screen.queryByText(pattern)).not.toBeInTheDocument();
    }
  });

  it("submits and shows a success state without claiming a live account was created", async () => {
    const user = userEvent.setup();
    render(<EarlyAccessForm />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /request early access/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/early-access list/i);
    });
    expect(screen.queryByText(/account created/i)).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/early-access",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows a rate-limit-specific message on a 429 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Too many" }), { status: 429 })),
    );
    const user = userEvent.setup();
    render(<EarlyAccessForm />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /request early access/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/too many submissions/i);
    });
  });

  it("shows a generic error state on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const user = userEvent.setup();
    render(<EarlyAccessForm />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /request early access/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });
});
