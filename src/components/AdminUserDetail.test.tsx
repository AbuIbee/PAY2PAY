import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminUserDetail } from "./AdminUserDetail";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams({ id: "user-1" }),
}));

function jsonResponse(body: unknown, ok = true, status?: number) {
  return { ok, status: status ?? (ok ? 200 : 400), json: async () => body } as Response;
}

const BASE_USER = {
  id: "user-1",
  email: "member@example.com",
  status: "active",
  platformRole: "member" as const,
  accountClassification: "production",
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  personalProfileId: "profile-1",
  businessProfiles: [],
  agreements: [],
};

/**
 * Closed-beta remediation (DEF-UAT-009/DEF-UAT-010): AdminUserDetail's suspend/reactivate/revoke-
 * sessions/role-change/start-impersonation actions are all server-side step-up gated
 * (AdminService.requireFreshStepUp), but this component previously used raw fetch() with no
 * StepUpChallenge UI at all — a real admin hit an opaque, permanent 403 and could never complete the
 * action. These tests prove the challenge now appears and the original action is retried after
 * verification, for two independently-wired actions (suspend and role change), confirming the shared
 * activeChallenge discriminator correctly routes each retry to its own action.
 */
describe("AdminUserDetail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a step-up challenge when suspending a user, and retries after verification", async () => {
    let suspended = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/users/detail")) return jsonResponse(BASE_USER);
      if (url.includes("/api/admin/whoami")) return jsonResponse({ platformRole: "platform_admin" });
      if (url.includes("/api/admin/impersonation/active")) return jsonResponse({ active: null });
      if (url.includes("/api/admin/users/suspend") && init?.method === "POST") {
        if (!suspended) {
          return jsonResponse(
            { status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required." },
            false,
            403,
          );
        }
        return jsonResponse({ status: "ok" });
      }
      if (url.includes("/api/auth/mfa/status")) return jsonResponse({ enrolled: true, methods: ["totp"] });
      if (url.includes("/api/auth/mfa/step-up/initiate")) return jsonResponse({ status: "ok" });
      if (url.includes("/api/auth/mfa/step-up/verify")) {
        suspended = true;
        return jsonResponse({ passed: true });
      }
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminUserDetail />);
    await waitFor(() => expect(screen.getByText("member@example.com")).toBeInTheDocument());

    await user.type(screen.getByLabelText(/reason/i), "Reported abuse");
    await user.click(screen.getByRole("button", { name: /^suspend$/i }));

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/code from your authenticator app/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => {
      const suspendCalls = fetchMock.mock.calls.filter(([callUrl]) => String(callUrl).includes("/api/admin/users/suspend"));
      expect(suspendCalls).toHaveLength(2);
    });
  });

  it("shows a step-up challenge when promoting a user's role, and retries after verification", async () => {
    let promoted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/users/detail")) return jsonResponse(promoted ? { ...BASE_USER, platformRole: "platform_admin" } : BASE_USER);
      if (url.includes("/api/admin/whoami")) return jsonResponse({ platformRole: "platform_owner" });
      if (url.includes("/api/admin/impersonation/active")) return jsonResponse({ active: null });
      if (url.includes("/api/admin/users/role") && init?.method === "POST") {
        if (!promoted) {
          return jsonResponse(
            { status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required." },
            false,
            403,
          );
        }
        return jsonResponse({ status: "ok" });
      }
      if (url.includes("/api/auth/mfa/status")) return jsonResponse({ enrolled: true, methods: ["totp"] });
      if (url.includes("/api/auth/mfa/step-up/initiate")) return jsonResponse({ status: "ok" });
      if (url.includes("/api/auth/mfa/step-up/verify")) {
        promoted = true;
        return jsonResponse({ passed: true });
      }
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminUserDetail />);
    await waitFor(() => expect(screen.getByText("member@example.com")).toBeInTheDocument());

    await user.type(screen.getByLabelText(/reason/i), "Onboarding as admin");
    await user.click(screen.getByRole("button", { name: /promote to platform admin/i }));

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/code from your authenticator app/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => {
      const roleCalls = fetchMock.mock.calls.filter(([callUrl]) => String(callUrl).includes("/api/admin/users/role"));
      expect(roleCalls).toHaveLength(2);
    });
    await waitFor(() => expect(screen.getByText("platform_admin", { exact: false })).toBeInTheDocument());
  });

  /** Section D (closed-beta remediation): close/deactivate is a status-only, non-destructive lifecycle change. */
  it("closes an account after confirmation, with a step-up challenge", async () => {
    let closed = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/users/detail")) return jsonResponse(closed ? { ...BASE_USER, status: "closed" } : BASE_USER);
      if (url.includes("/api/admin/whoami")) return jsonResponse({ platformRole: "platform_admin" });
      if (url.includes("/api/admin/impersonation/active")) return jsonResponse({ active: null });
      if (url.includes("/api/admin/users/close") && init?.method === "POST") {
        if (!closed) {
          return jsonResponse(
            { status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required." },
            false,
            403,
          );
        }
        return jsonResponse({ status: "closed" });
      }
      if (url.includes("/api/auth/mfa/status")) return jsonResponse({ enrolled: true, methods: ["totp"] });
      if (url.includes("/api/auth/mfa/step-up/initiate")) return jsonResponse({ status: "ok" });
      if (url.includes("/api/auth/mfa/step-up/verify")) {
        closed = true;
        return jsonResponse({ passed: true });
      }
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<AdminUserDetail />);
    await waitFor(() => expect(screen.getByText("member@example.com")).toBeInTheDocument());

    await user.type(screen.getByLabelText(/reason/i), "Account closure requested");
    await user.click(screen.getByRole("button", { name: /close account/i }));

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/code from your authenticator app/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => expect(screen.getByText(/this account is closed/i)).toBeInTheDocument());
  });

  it("does not close the account when the confirmation dialog is declined", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/admin/users/detail")) return jsonResponse(BASE_USER);
      if (url.includes("/api/admin/whoami")) return jsonResponse({ platformRole: "platform_admin" });
      if (url.includes("/api/admin/impersonation/active")) return jsonResponse({ active: null });
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();

    render(<AdminUserDetail />);
    await waitFor(() => expect(screen.getByText("member@example.com")).toBeInTheDocument());

    await user.type(screen.getByLabelText(/reason/i), "Account closure requested");
    await user.click(screen.getByRole("button", { name: /close account/i }));

    expect(fetchMock.mock.calls.some(([callUrl]) => String(callUrl).includes("/api/admin/users/close"))).toBe(false);
  });

  it("shows a step-up challenge when sending a password reset, and confirms once sent", async () => {
    let sent = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/users/detail")) return jsonResponse(BASE_USER);
      if (url.includes("/api/admin/whoami")) return jsonResponse({ platformRole: "platform_admin" });
      if (url.includes("/api/admin/impersonation/active")) return jsonResponse({ active: null });
      if (url.includes("/api/admin/users/password-reset") && init?.method === "POST") {
        if (!sent) {
          return jsonResponse(
            { status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required." },
            false,
            403,
          );
        }
        return jsonResponse({ status: "sent" });
      }
      if (url.includes("/api/auth/mfa/status")) return jsonResponse({ enrolled: true, methods: ["totp"] });
      if (url.includes("/api/auth/mfa/step-up/initiate")) return jsonResponse({ status: "ok" });
      if (url.includes("/api/auth/mfa/step-up/verify")) {
        sent = true;
        return jsonResponse({ passed: true });
      }
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminUserDetail />);
    await waitFor(() => expect(screen.getByText("member@example.com")).toBeInTheDocument());

    await user.type(screen.getByLabelText(/reason/i), "User locked out");
    await user.click(screen.getByRole("button", { name: /send password reset email/i }));

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/code from your authenticator app/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => expect(screen.getByText(/password reset email sent/i)).toBeInTheDocument());
  });
});
