import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminVerificationQueue } from "./AdminVerificationQueue";

const RECORD = {
  id: "record-1",
  profileKind: "personal" as const,
  profileId: "profile-1",
  tier: "full",
  createdAt: new Date().toISOString(),
};

/**
 * Closed-beta remediation (DEF-UAT-020): the first admin UI ever built for identity-verification
 * decisions — proves an admin can actually see and approve/reject a pending request through the app,
 * not just via a service method with zero caller.
 */
describe("AdminVerificationQueue", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists pending verification requests and lets an admin approve one", async () => {
    let decided = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/admin/verification/decide")) {
        decided = true;
        return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("/api/admin/verification")) {
        return new Response(JSON.stringify({ records: decided ? [] : [RECORD] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminVerificationQueue />);
    await waitFor(() => expect(screen.getByText(/profile-1/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(screen.getByText(/no pending requests/i)).toBeInTheDocument());
    const decideCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/admin/verification/decide");
    expect(decideCall).toBeDefined();
    expect(JSON.parse((decideCall![1] as RequestInit).body as string)).toEqual({
      profileKind: "personal",
      profileId: "profile-1",
      decision: "verified",
      reason: null,
    });
  });

  it("requires a reason before allowing a rejection", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/verification")) {
        return new Response(JSON.stringify({ records: [RECORD] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const testUser = userEvent.setup();

    render(<AdminVerificationQueue />);
    await waitFor(() => expect(screen.getByText(/profile-1/i)).toBeInTheDocument());

    await testUser.click(screen.getByRole("button", { name: /reject/i }));

    await waitFor(() => expect(screen.getByText(/reason is required/i)).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/admin/verification/decide"))).toBe(false);
  });

  it("shows a clear message when the caller lacks the decide_identity_verification capability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ status: "error", code: "FORBIDDEN", message: "Administrative access is required." }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<AdminVerificationQueue />);
    await waitFor(() => expect(screen.getByText(/decide_identity_verification capability/i)).toBeInTheDocument());
  });
});
