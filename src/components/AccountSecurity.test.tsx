import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSecurity } from "./AccountSecurity";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const NO_SESSIONS = { sessions: [] };

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
      if (input === "/api/account/sessions") {
        return { ok: true, status: 200, json: async () => NO_SESSIONS };
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

    const codeInput = screen.getByLabelText(/enter the 6-digit code your app now shows/i);
    await user.type(codeInput, "654321");
    await user.click(screen.getByRole("button", { name: /^confirm$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/mfa/totp/confirm",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "654321" }) }),
      );
    });
    expect(await screen.findByText(/^enabled$/i)).toBeInTheDocument();
    expect(await screen.findByText(/authenticator app two-factor authentication is now enabled/i)).toBeInTheDocument();
  });

  /**
   * Section B (closed-beta remediation, Product Owner review): disableMethod previously had no
   * caller anywhere in the codebase — there was no way to remove an enrolled method through the UI at
   * all. Proves the control exists, requires a fresh step-up, and reflects the change once verified.
   */
  it("shows a step-up challenge when disabling an enrolled method, and reflects the change once verified", async () => {
    let disabled = false;
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/auth/mfa/status") {
        return { ok: true, status: 200, json: async () => ({ enrolled: !disabled, methods: disabled ? [] : ["totp"] }) };
      }
      if (input === "/api/account/sessions") {
        return { ok: true, status: 200, json: async () => NO_SESSIONS };
      }
      if (input === "/api/auth/mfa/disable" && init?.method === "POST") {
        if (!disabled) {
          return {
            ok: false,
            status: 403,
            json: async () => ({ status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required." }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ status: "disabled" }) };
      }
      if (input === "/api/auth/mfa/step-up/initiate" && init?.method === "POST") return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      if (input === "/api/auth/mfa/step-up/verify" && init?.method === "POST") {
        disabled = true;
        return { ok: true, status: 200, json: async () => ({ passed: true }) };
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AccountSecurity />);
    expect(await screen.findByText(/^enabled$/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /disable authenticator app/i }));

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/code from your authenticator app/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => expect(screen.getByText(/not set up/i)).toBeInTheDocument());
  });

  // PRSprint 06 (docs/prsprints/PRSPRINT_06_AUTHENTICATION_SESSION_HARDENING.md): device/session
  // visibility replaced the old "isn't available yet" placeholder this test used to assert on.
  it("lists signed-in devices, marks the current one, and can revoke another device", async () => {
    let sessions = [
      { id: "session-current", createdAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-02T00:00:00Z", expiresAt: "2026-02-01T00:00:00Z", ipAddress: "203.0.113.1", userAgent: "Chrome on macOS", isCurrent: true },
      { id: "session-other", createdAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T12:00:00Z", expiresAt: "2026-02-01T00:00:00Z", ipAddress: "198.51.100.2", userAgent: "Safari on iPhone", isCurrent: false },
    ];
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/auth/mfa/status") {
        return { ok: true, status: 200, json: async () => ({ enrolled: false, methods: [] }) };
      }
      if (input === "/api/account/sessions") {
        return { ok: true, status: 200, json: async () => ({ sessions }) };
      }
      if (input === "/api/account/sessions/revoke" && init?.method === "POST") {
        const { sessionId } = JSON.parse(init.body as string) as { sessionId: string };
        sessions = sessions.filter((s) => s.id !== sessionId);
        return { ok: true, status: 200, json: async () => ({ status: "session_revoked" }) };
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AccountSecurity />);
    expect(await screen.findByText("Chrome on macOS")).toBeInTheDocument();
    expect(screen.getByText("Safari on iPhone")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^revoke$/i }));

    await waitFor(() => {
      expect(screen.queryByText("Safari on iPhone")).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/sessions/revoke",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ sessionId: "session-other" }) }),
    );
  });
});
