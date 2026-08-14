import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSecurity } from "./AccountSecurity";

describe("AccountSecurity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows 'Not set up' before enrollment and completes TOTP enrollment end to end", async () => {
    let confirmed = false;
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/auth/mfa/status") {
        return { ok: true, status: 200, json: async () => ({ enrolled: confirmed, methods: confirmed ? ["totp"] : [] }) };
      }
      if (input === "/api/auth/mfa/totp/enroll" && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ secret: "ABCD1234", otpauthUri: "otpauth://totp/PAY2PAY?secret=ABCD1234" }) };
      }
      if (input === "/api/auth/mfa/totp/confirm" && init?.method === "POST") {
        confirmed = true;
        return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AccountSecurity />);
    expect(await screen.findByText(/not set up/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /set up authenticator app/i }));
    expect(await screen.findByText("ABCD1234")).toBeInTheDocument();

    const codeInput = screen.getByLabelText(/6-digit code from your app/i);
    await user.type(codeInput, "654321");
    await user.click(screen.getByRole("button", { name: /^confirm$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/mfa/totp/confirm",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "654321" }) }),
      );
    });
    expect(await screen.findByText(/^enabled$/i)).toBeInTheDocument();
  });

  it("notes that device-session management is not available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ enrolled: false, methods: [] }) }),
    );
    render(<AccountSecurity />);
    expect(await screen.findByText(/device and session management isn't available yet/i)).toBeInTheDocument();
  });
});
