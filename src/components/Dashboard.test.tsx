import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

const PERSONAL_PROFILE = { kind: "personal" as const, personalProfileId: "profile-1", displayName: "Personal" };

/**
 * Section M (closed-beta remediation, Product Owner review): "Pending invitations" and "Agreements
 * needing signature" previously showed static copy regardless of actual data, even though
 * /api/dashboard/personal already computed exactly this via `requests`. These tests prove the cards
 * now reflect the real counts.
 */
describe("Dashboard action cards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function buildFetchMock(requests: Array<{ agreementId: string | null; reason: string; invitationId?: string }>) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/profiles") return jsonResponse({ profiles: [PERSONAL_PROFILE] });
      if (url === "/api/profiles/active") return jsonResponse(PERSONAL_PROFILE);
      if (url === "/api/dashboard/personal") {
        return jsonResponse({
          moneyIOweMinorUnits: 0,
          moneyOwedToMeMinorUnits: 0,
          agreements: [],
          upcomingPayments: [],
          requests,
        });
      }
      if (url === "/api/notifications") return jsonResponse({ notifications: [] });
      throw new Error(`Unhandled fetch: ${url}`);
    });
  }

  it("shows real counts for pending invitations and agreements needing signature", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchMock([
        { agreementId: null, reason: "pending_connection_invitation", invitationId: "inv-1" },
        { agreementId: null, reason: "pending_connection_invitation", invitationId: "inv-2" },
        { agreementId: "agr-1", reason: "awaiting_your_signature" },
      ]),
    );

    render(<Dashboard />);

    expect(await screen.findByText("2 waiting on your response")).toBeInTheDocument();
    expect(screen.getByText("1 awaiting your signature")).toBeInTheDocument();
  });

  it("shows a clear zero-state instead of a stale generic message when nothing is pending", async () => {
    vi.stubGlobal("fetch", buildFetchMock([]));

    render(<Dashboard />);

    expect(await screen.findByText("No pending invitations")).toBeInTheDocument();
    expect(screen.getByText("Nothing awaiting your signature")).toBeInTheDocument();
  });

  it("no longer claims a failed/retry-specific payments filter that doesn't exist", async () => {
    vi.stubGlobal("fetch", buildFetchMock([]));

    render(<Dashboard />);

    await screen.findByText("No pending invitations");
    expect(screen.getByText("View your payment history and status")).toBeInTheDocument();
    expect(screen.queryByText(/failed payments or retries due/i)).not.toBeInTheDocument();
  });
});
