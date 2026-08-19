import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentMethodsList } from "./PaymentMethodsList";

function mockSequence(responses: Array<{ body: unknown; ok?: boolean; status?: number }>) {
  let call = 0;
  return vi.fn().mockImplementation(() => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve({
      ok: next?.ok ?? true,
      status: next?.status ?? 200,
      json: async () => next?.body,
    });
  });
}

describe("PaymentMethodsList", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an empty state with add-account links when there are no accounts", async () => {
    vi.stubGlobal(
      "fetch",
      mockSequence([
        { body: { kind: "personal", personalProfileId: "profile-1" } },
        { body: { accounts: [] } },
      ]),
    );
    render(<PaymentMethodsList />);
    expect(await screen.findByText(/no bank account connected/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect bank account/i })).toHaveAttribute("href", "/payment-methods/add-bank");
    expect(screen.getByRole("link", { name: /add debit card/i })).toHaveAttribute("href", "/payment-methods/add-card");
  });

  it("renders a verified bank account and a pending-verification card with plain-language status chips", async () => {
    vi.stubGlobal(
      "fetch",
      mockSequence([
        { body: { kind: "personal", personalProfileId: "profile-1" } },
        {
          body: {
            accounts: [
              {
                id: "acct-1",
                accountType: "bank_account",
                providerName: "sandbox_mock",
                maskedLast4: "1234",
                institutionDisplayName: "First Sandbox Bank",
                cardExpiryMonth: null,
                cardExpiryYear: null,
                cardBrand: null,
                bankAccountSubtype: "checking",
                status: "verified",
                createdAt: new Date().toISOString(),
              },
              {
                id: "acct-2",
                accountType: "debit_card",
                providerName: "sandbox-card-processor",
                maskedLast4: "4321",
                institutionDisplayName: null,
                cardExpiryMonth: 8,
                cardExpiryYear: 2028,
                cardBrand: "Visa",
                bankAccountSubtype: null,
                status: "pending_verification",
                createdAt: new Date().toISOString(),
              },
            ],
          },
        },
      ]),
    );
    render(<PaymentMethodsList />);

    expect(await screen.findByText("First Sandbox Bank")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText("Visa card")).toBeInTheDocument();
    expect(screen.getByText("Verification pending")).toBeInTheDocument();
    // Never render raw enum strings.
    expect(screen.queryByText("verified")).not.toBeInTheDocument();
    expect(screen.queryByText("pending_verification")).not.toBeInTheDocument();
    // Never display full/raw account numbers — only the masked last 4.
    expect(screen.getByText(/checking.*1234/i)).toBeInTheDocument();
    expect(screen.getByText(/ending in 4321/i)).toBeInTheDocument();
  });

  it("shows a sign-in prompt when the session is unauthenticated", async () => {
    vi.stubGlobal("fetch", mockSequence([{ body: { message: "Authentication required." }, ok: false, status: 401 }]));
    render(<PaymentMethodsList />);
    expect(await screen.findByText(/sign in/i)).toBeInTheDocument();
  });
});
