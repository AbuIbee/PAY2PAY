import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountDashboard } from "./AccountDashboard";

const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

/**
 * Section N (closed-beta remediation, Product Owner review): this page previously had its own
 * complete, duplicate MFA enrollment flow (separate from AccountSecurity.tsx at /account/security)
 * with copy claiming "sensitive actions... become available in later phases" — false, since sensitive
 * actions were already step-up gated by the time of this remediation. Replaced with a status line and
 * a link to the one real MFA management surface, avoiding a second, drift-prone implementation.
 */
describe("AccountDashboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows MFA status and links to the Security page instead of duplicating its enrollment flow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ email: "user@example.com", mfaEnrolled: false, publicReference: "P2P-ABCD2345" })),
    );

    render(<AccountDashboard />);

    expect(await screen.findByText("Not enrolled")).toBeInTheDocument();
    expect(screen.queryByText(/become available in later phases/i)).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: /set up two-factor authentication/i });
    expect(link).toHaveAttribute("href", "/account/security");
  });

  it("shows a manage link and no setup prompt once already enrolled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ email: "user@example.com", mfaEnrolled: true, publicReference: "P2P-ABCD2345" })),
    );

    render(<AccountDashboard />);

    expect(await screen.findByText("Enrolled")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /manage two-factor authentication/i })).toHaveAttribute("href", "/account/security");
  });

  it("displays the account reference", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ email: "user@example.com", mfaEnrolled: false, publicReference: "P2P-ABCD2345" })),
    );

    render(<AccountDashboard />);

    expect(await screen.findByText("P2P-ABCD2345")).toBeInTheDocument();
  });

  describe("Simple Resend Verification Email (Agreement Lifecycle V2 UAT)", () => {
    it("shows 'Resend verification email' for an unverified user, and a success message once clicked", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/account/dashboard")) {
          return jsonResponse({ email: "user@example.com", mfaEnrolled: false, publicReference: "P2P-ABCD2345", emailVerified: false });
        }
        if (url.includes("/api/auth/resend-verification")) {
          return jsonResponse({ status: "ok" });
        }
        return jsonResponse({}, false);
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<AccountDashboard />);
      const button = await screen.findByRole("button", { name: /resend verification email/i });
      await user.click(button);

      expect(await screen.findByText("Verification email sent.")).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/auth/resend-verification"))).toBe(true);
    });

    it("does not show 'Resend verification email' once the user's email is already verified", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ email: "user@example.com", mfaEnrolled: false, publicReference: "P2P-ABCD2345", emailVerified: true })),
      );

      render(<AccountDashboard />);
      await screen.findByText("P2P-ABCD2345");

      expect(screen.queryByRole("button", { name: /resend verification email/i })).not.toBeInTheDocument();
    });
  });
});
