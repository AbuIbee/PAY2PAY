import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminRiskEvents } from "./AdminRiskEvents";

const EVENT = {
  id: "event-1",
  userId: "user-1",
  signalType: "repeated_payment_failure",
  severity: "medium",
  outcome: "flagged",
  relatedResourceType: "payment_attempt",
  relatedResourceId: "pay-1",
  detail: { count: 3 },
  createdAt: new Date().toISOString(),
  reviewState: "open",
  reviewedByUserId: null,
  reviewedAt: null,
};

/**
 * SPRINT_20_ClosedBetaReadiness: Sprint 19's fraud/risk signal model (GET /api/admin/risk-events,
 * POST /api/admin/risk-events/review) shipped with zero UI — this is the first real admin surface
 * for it, proving an admin can actually see and review a flagged signal through the app.
 */
describe("AdminRiskEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists open risk signals and lets an admin mark one reviewed", async () => {
    let reviewed = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/admin/risk-events/review") || (url === "/api/admin/risk-events/review" && init?.method === "POST")) {
        reviewed = true;
        return new Response(JSON.stringify({ event: { ...EVENT, reviewState: "reviewed" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("/api/admin/risk-events")) {
        return new Response(JSON.stringify({ events: reviewed ? [] : [EVENT] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminRiskEvents />);
    await waitFor(() => expect(screen.getByText(/repeated payment failure/i)).toBeInTheDocument());
    expect(screen.getByText("user-1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /mark reviewed/i }));

    await waitFor(() => expect(screen.getByText(/no open risk signals/i)).toBeInTheDocument());
    const reviewCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/admin/risk-events/review");
    expect(reviewCall).toBeDefined();
    expect(JSON.parse((reviewCall![1] as RequestInit).body as string)).toEqual({ id: "event-1", decision: "reviewed" });
  });

  it("shows a clear message when the caller lacks the review_fraud_alert capability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ status: "error", code: "FORBIDDEN", message: "Administrative access is required." }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<AdminRiskEvents />);
    await waitFor(() => expect(screen.getByText(/review_fraud_alert capability/i)).toBeInTheDocument());
  });
});
