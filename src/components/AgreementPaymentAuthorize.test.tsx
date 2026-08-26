import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgreementPaymentAuthorize } from "./AgreementPaymentAuthorize";

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({ current: new URLSearchParams({ id: "agreement-1" }) }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useSearchParams: () => mockParams.current,
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 201 : 400, json: async () => body } as Response;
}

/**
 * Restore agreement payment functionality: covers the one-click mandate-authorization page —
 * requires an explicit click (never auto-fires on load, since this authorizes real debits), shows
 * the real server error on failure, and returns the user to the agreement's Make Payment section on
 * success.
 */
describe("AgreementPaymentAuthorize", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockRouterPush.mockClear();
    mockParams.current = new URLSearchParams({ id: "agreement-1" });
  });

  it("never authorizes automatically on load — requires an explicit click", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "mandate-1", status: "active" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AgreementPaymentAuthorize />);
    await screen.findByRole("button", { name: /authorize payment method/i });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("authorizes on click and returns to the agreement's Make Payment section", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({ id: "mandate-1", status: "active" });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AgreementPaymentAuthorize />);
    await user.click(await screen.findByRole("button", { name: /authorize payment method/i }));
    await waitFor(() => expect(screen.getByText(/payment method authorized/i)).toBeInTheDocument());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/agreements/payment-setup/authorize-mandate");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ agreementId: "agreement-1" });

    await user.click(screen.getByRole("button", { name: /back to agreement/i }));
    expect(mockRouterPush).toHaveBeenCalledWith("/agreements/detail?id=agreement-1#make-payment");
  });

  it("shows the real server error and lets the user retry", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: "error", code: "VALIDATION_ERROR", message: "Add a funding account before authorizing payments on this agreement." }, false),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgreementPaymentAuthorize />);
    await user.click(await screen.findByRole("button", { name: /authorize payment method/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/add a funding account/i));
    expect(screen.getByRole("button", { name: /authorize payment method/i })).toBeEnabled();
  });

  it("shows a clear message when no agreement id is present in the URL", () => {
    mockParams.current = new URLSearchParams();
    render(<AgreementPaymentAuthorize />);
    expect(screen.getByRole("alert")).toHaveTextContent(/no agreement was specified/i);
  });
});
