import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionDetail } from "./ConnectionDetail";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams({ id: "rel-1" }),
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

const BUSINESS_PARTICIPANT = {
  id: "participant-business",
  relationshipId: "rel-1",
  individualProfileId: null,
  organizationId: "org-1",
  role: "creditor",
  status: "active",
  representedByUserId: "me",
};

const COUNTERPARTY_PARTICIPANT = {
  id: "participant-personal",
  relationshipId: "rel-1",
  individualProfileId: "profile-2",
  organizationId: null,
  role: "debtor",
  status: "active",
  representedByUserId: "them",
};

function buildFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) return jsonResponse({ id: "me", email: "me@example.com" });
    if (url.includes("/api/relationships/detail")) {
      return jsonResponse({
        relationship: { id: "rel-1", status: "financial_setup_pending", currentAgreementId: null, createdAt: "2026-01-01T00:00:00.000Z" },
        participants: [BUSINESS_PARTICIPANT, COUNTERPARTY_PARTICIPANT],
      });
    }
    if (url.includes("/api/relationships/activate/check")) {
      return jsonResponse({ eligible: false, reasons: ["funding_account_missing", "payout_account_missing", "agreement_missing"] });
    }
    if (url.includes("/api/relationships/accounts?")) {
      return jsonResponse({ assignments: [] });
    }
    if (url.includes("/api/relationships/accounts/party")) {
      return jsonResponse({ accounts: [] });
    }
    return jsonResponse({}, false);
  });
}

describe("ConnectionDetail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scopes the party-owned account lookup to the organization, not the acting staff member's personal profile, when the caller's participation is a business", async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectionDetail />);
    await waitFor(() => expect(screen.getByText("Setup progress")).toBeInTheDocument());

    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    const partyCall = calledUrls.find((url) => url.includes("/api/relationships/accounts/party"));
    expect(partyCall).toContain("partyKind=business");
    expect(partyCall).toContain("partyId=org-1");
    expect(partyCall).not.toContain("partyKind=personal");
  });

  it("renders the setup tracker from the re-fetched activation-check reasons, not from relationship status alone", async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectionDetail />);
    await waitFor(() => expect(screen.getByText("Setup progress")).toBeInTheDocument());

    // counterparty_missing is absent from the mocked reasons, so this step must read as complete —
    // proving the tracker reflects the fetched reasons rather than a hardcoded/inferred sequence.
    const counterpartyRow = screen.getByText("Counterparty connected").closest("li");
    expect(counterpartyRow).toHaveTextContent("Done");

    const agreementRow = screen.getByText("Agreement ready").closest("li");
    expect(agreementRow).toHaveTextContent("Pending");
  });

  it("labels participants without leaking a raw organization or profile id", async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectionDetail />);
    await waitFor(() => expect(screen.getByText(/You \(Creditor\)/)).toBeInTheDocument());
    expect(screen.queryByText(/org-1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/profile-2/)).not.toBeInTheDocument();
  });
});
