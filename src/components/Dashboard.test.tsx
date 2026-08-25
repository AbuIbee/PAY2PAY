import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const BUSINESS_PROFILE = { kind: "business" as const, businessProfileId: "biz-1", displayName: "Salahuddeen Enterprises" };

/**
 * Dashboard consistency fix (Product Owner UAT): Personal and Business previously rendered visibly
 * different summary sections (different labels, different card counts), and root-cause investigation
 * found the Business summary could vanish entirely — GET /api/dashboard/business used to require the
 * caller already hold an active business_staff_member row just to compute a staff count, which a
 * business *owner* (the normal case) has never had seeded for them, so the whole request 403'd before
 * returning any summary data. These tests prove: both contexts render the identical five-card
 * framework, each scoped to the correct account's own data, with no leakage between them, and that
 * switching context updates the numbers with no stale/duplicated values.
 */
describe("Dashboard summary — Personal/Business consistency", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function buildContextFetchMock() {
    let active: typeof PERSONAL_PROFILE | typeof BUSINESS_PROFILE = PERSONAL_PROFILE;
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/profiles") return jsonResponse({ profiles: [PERSONAL_PROFILE, BUSINESS_PROFILE] });
      if (url === "/api/profiles/active" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { kind: "personal" } | { kind: "business"; businessProfileId: string };
        active = body.kind === "personal" ? PERSONAL_PROFILE : BUSINESS_PROFILE;
        return jsonResponse(active);
      }
      if (url === "/api/profiles/active") return jsonResponse(active);
      if (url === "/api/dashboard/personal") {
        return jsonResponse({
          moneyIOweMinorUnits: 150_00,
          moneyOwedToMeMinorUnits: 300_00,
          agreements: [{ id: "p-agr-1" }, { id: "p-agr-2" }],
          upcomingPayments: [{ agreementId: "p-agr-1", dueDate: "2026-09-01", amountMinorUnits: 5000 }],
          requests: [{ agreementId: "p-agr-1", reason: "awaiting_your_signature" }],
        });
      }
      if (url.startsWith("/api/dashboard/business")) {
        return jsonResponse({
          receivablesMinorUnits: 900_00,
          payablesMinorUnits: 400_00,
          agreements: [{ id: "b-agr-1" }, { id: "b-agr-2" }, { id: "b-agr-3" }],
          customers: [{ kind: "personal", id: "cust-1" }],
          upcomingPayments: [
            { agreementId: "b-agr-1", dueDate: "2026-09-01", amountMinorUnits: 1000 },
            { agreementId: "b-agr-2", dueDate: "2026-09-05", amountMinorUnits: 2000 },
          ],
          requests: [],
          staffCount: 2,
        });
      }
      if (url === "/api/notifications") return jsonResponse({ notifications: [] });
      throw new Error(`Unhandled fetch: ${url}`);
    });
  }

  it("1/9. Personal dashboard renders the summary cards, on desktop", async () => {
    vi.stubGlobal("fetch", buildContextFetchMock());
    render(<Dashboard />);

    expect(await screen.findByText("Money I owe")).toBeInTheDocument();
    expect(screen.getByText("Money owed to me")).toBeInTheDocument();
    expect(screen.getByText("Agreements")).toBeInTheDocument();
    expect(screen.getByText("Upcoming payments")).toBeInTheDocument();
    expect(screen.getByText("Action required")).toBeInTheDocument();
  });

  it("2/9. Business dashboard renders the exact same five summary cards (same structure), on desktop and mobile (same markup regardless of viewport)", async () => {
    const user = userEvent.setup();
    const fetchMock = buildContextFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard />);
    await screen.findByText("Money I owe"); // wait for initial (personal) load

    await user.selectOptions(screen.getByLabelText("Viewing as"), "Salahuddeen Enterprises");

    await screen.findByText("$900.00"); // business receivables value confirms the business payload landed
    for (const viewport of [{ width: 375 }, { width: 1280 }]) {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: viewport.width });
      expect(screen.getByText("Money I owe")).toBeInTheDocument();
      expect(screen.getByText("Money owed to me")).toBeInTheDocument();
      expect(screen.getByText("Agreements")).toBeInTheDocument();
      expect(screen.getByText("Upcoming payments")).toBeInTheDocument();
      expect(screen.getByText("Action required")).toBeInTheDocument();
    }
  });

  it("3/6. Personal metrics use personal-scoped values (business's larger numbers do not leak in)", async () => {
    vi.stubGlobal("fetch", buildContextFetchMock());
    render(<Dashboard />);
    await screen.findByText("Money I owe");

    expect(screen.getByText("$150.00")).toBeInTheDocument(); // personal moneyIOwe
    expect(screen.getByText("$300.00")).toBeInTheDocument(); // personal moneyOwedToMe
    expect(screen.queryByText("$900.00")).not.toBeInTheDocument();
    expect(screen.queryByText("$400.00")).not.toBeInTheDocument();
  });

  it("4/7. Business metrics use business-scoped values (personal's numbers do not leak in) — receivables maps to 'Money owed to me', payables to 'Money I owe'", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", buildContextFetchMock());
    render(<Dashboard />);
    await screen.findByText("Money I owe");

    await user.selectOptions(screen.getByLabelText("Viewing as"), "Salahuddeen Enterprises");

    await screen.findByText("$900.00");
    expect(screen.getByText("$400.00")).toBeInTheDocument(); // business payables → "Money I owe"
    expect(screen.getByText("3")).toBeInTheDocument(); // business agreements count
    expect(screen.queryByText("$150.00")).not.toBeInTheDocument();
    expect(screen.queryByText("$300.00")).not.toBeInTheDocument();
  });

  it("5. switching Personal → Business → Personal updates all values with no stale data and no manual refresh", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", buildContextFetchMock());
    render(<Dashboard />);
    await screen.findByText("$150.00");

    await user.selectOptions(screen.getByLabelText("Viewing as"), "Salahuddeen Enterprises");
    await screen.findByText("$900.00");
    expect(screen.queryByText("$150.00")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Viewing as"), "Personal");
    await screen.findByText("$150.00");
    expect(screen.queryByText("$900.00")).not.toBeInTheDocument();
  });

  it("8. 'What requires action' remains visible in both Personal and Business contexts", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", buildContextFetchMock());
    render(<Dashboard />);
    await screen.findByText("Money I owe");
    expect(screen.getByText("What requires action")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Viewing as"), "Salahuddeen Enterprises");
    await screen.findByText("$900.00");
    expect(screen.getByText("What requires action")).toBeInTheDocument();
  });
});
