import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminBusinessDetail } from "./AdminBusinessDetail";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams({ id: "business-1" }),
}));

function jsonResponse(body: unknown, ok = true, status?: number) {
  return { ok, status: status ?? (ok ? 200 : 400), json: async () => body } as Response;
}

const BASE_BUSINESS = {
  id: "business-1",
  legalBusinessName: "Adam's Auto Parts LLC",
  displayName: "Adam's Auto Parts",
  entityType: "llc",
  country: "US",
  state: "TX",
  status: "active",
  ownerUserId: "owner-1",
  ownerEmail: "owner@example.com",
  ownerPlatformRole: "member",
  members: [],
  agreements: [],
};

/**
 * Closed-beta remediation (DEF-UAT-009/DEF-UAT-010): identical fix to AdminUserDetail — Suspend/
 * Reactivate here are step-up gated server-side but this component had no StepUpChallenge UI at all.
 */
describe("AdminBusinessDetail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a step-up challenge when suspending a business, and retries after verification", async () => {
    let suspended = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/businesses/detail")) return jsonResponse(BASE_BUSINESS);
      if (url.includes("/api/admin/businesses/suspend") && init?.method === "POST") {
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

    render(<AdminBusinessDetail />);
    await waitFor(() => expect(screen.getByText("Adam's Auto Parts")).toBeInTheDocument());

    await user.type(screen.getByLabelText(/reason/i), "Fraud report");
    await user.click(screen.getByRole("button", { name: /^suspend$/i }));

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/code from your authenticator app/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => {
      const suspendCalls = fetchMock.mock.calls.filter(([callUrl]) => String(callUrl).includes("/api/admin/businesses/suspend"));
      expect(suspendCalls).toHaveLength(2);
    });
  });
});
