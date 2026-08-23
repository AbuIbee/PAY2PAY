import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BankConnectionForm } from "./BankConnectionForm";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

const VALID_ROUTING = "021000021"; // Chase's real, publicly documented routing number.
const VALID_ACCOUNT = "123456789012";

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/name on the account/i), "Jordan Payer");
  await user.type(screen.getByLabelText(/^routing number$/i), VALID_ROUTING);
  await user.type(screen.getByLabelText(/^account number$/i), VALID_ACCOUNT);
  await user.type(screen.getByLabelText(/confirm account number/i), VALID_ACCOUNT);
}

describe("BankConnectionForm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    refresh.mockClear();
  });

  /**
   * SPRINT_20_ClosedBetaReadiness (P0): connectBankAccount gained a fresh-MFA-step-up requirement in
   * Sprint 19, but this form previously called apiFetch directly with no step-up handling at all — a
   * real user would hit a raw, unhandled 403 with no way to proceed. This proves the fix: the
   * step-up dialog appears, and a successful verification retries the original request and succeeds.
   */
  it("shows a step-up challenge when required, and completes the connection after verification", async () => {
    let connected = false;
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/profiles/active") return { ok: true, status: 200, json: async () => ({ kind: "personal", personalProfileId: "profile-1" }) };
      if (input === "/api/relationships/accounts/bank/connect" && init?.method === "POST") {
        if (!connected) {
          return {
            ok: false,
            status: 403,
            json: async () => ({ status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required before connecting a bank account." }),
          };
        }
        return { ok: true, status: 201, json: async () => ({ account: { id: "acct-1" } }) };
      }
      if (input === "/api/auth/mfa/status") return { ok: true, status: 200, json: async () => ({ enrolled: true, methods: ["totp"] }) };
      if (input === "/api/auth/mfa/step-up/initiate") return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      if (input === "/api/auth/mfa/step-up/verify") {
        connected = true;
        return { ok: true, status: 200, json: async () => ({ passed: true }) };
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<BankConnectionForm />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: /^connect bank account$/i }));

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/code from your authenticator app/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => {
      const connectCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/relationships/accounts/bank/connect");
      expect(connectCalls).toHaveLength(2);
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/payment-methods"));
  });

  it("submits normally with no step-up prompt when none is required", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/profiles/active") return { ok: true, status: 200, json: async () => ({ kind: "personal", personalProfileId: "profile-1" }) };
      if (input === "/api/relationships/accounts/bank/connect" && init?.method === "POST") {
        return { ok: true, status: 201, json: async () => ({ account: { id: "acct-1" } }) };
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<BankConnectionForm />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: /^connect bank account$/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/payment-methods"));
    expect(screen.queryByText(/verify it's you/i)).not.toBeInTheDocument();
  });
});
