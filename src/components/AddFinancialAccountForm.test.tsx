import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddFinancialAccountForm } from "./AddFinancialAccountForm";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

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

describe("AddFinancialAccountForm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables the submit button once submitting, preventing a duplicate request", async () => {
    const user = userEvent.setup();
    const fetchMock = mockSequence([
      { body: { kind: "personal", personalProfileId: "profile-1" } },
      { body: { account: { id: "acct-new" } }, status: 201 },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<AddFinancialAccountForm accountType="bank_account" />);

    await screen.findByLabelText(/bank name/i);
    await user.type(screen.getByLabelText(/bank name/i), "Sandbox Bank");
    await user.type(screen.getByLabelText(/last 4 digits/i), "1234");
    await user.type(screen.getByLabelText(/sandbox bank connection token/i), "tok_test_123");

    const submit = screen.getByRole("button", { name: /add bank account/i });
    // Fire two rapid clicks (a real double-click race) without awaiting between them.
    void user.click(submit);
    void user.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Only one POST to accounts/add, even though the button was clicked twice.
    const postCalls = fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "POST");
    expect(postCalls).toHaveLength(1);
  });

  it("shows required fields for a debit card and the fee-reallocation disclosure", async () => {
    vi.stubGlobal("fetch", mockSequence([{ body: { kind: "personal", personalProfileId: "profile-1" } }]));
    render(<AddFinancialAccountForm accountType="debit_card" />);

    await screen.findByLabelText(/card brand/i);
    expect(screen.getByLabelText(/expiry month/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/expiry year/i)).toBeInTheDocument();
    expect(screen.getByText(/incremental processing cost/i)).toBeInTheDocument();
  });
});
