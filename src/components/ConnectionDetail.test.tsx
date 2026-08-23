import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  /**
   * SPRINT_20_ClosedBetaReadiness (P0): replaceAccount gained a fresh-MFA-step-up requirement in
   * Sprint 19, but this handler previously called apiFetch directly with no step-up handling — a
   * real user replacing a funding/payout account would hit a raw, unhandled 403. This proves the
   * fix: the step-up dialog appears, and verification retries the original replace request.
   */
  it("shows a step-up challenge when replacing an already-assigned account, and retries after verification", async () => {
    let replaced = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return jsonResponse({ id: "me", email: "me@example.com" });
      if (url.includes("/api/relationships/detail")) {
        return jsonResponse({
          relationship: { id: "rel-1", status: "financial_setup_pending", currentAgreementId: null, createdAt: "2026-01-01T00:00:00.000Z" },
          participants: [BUSINESS_PARTICIPANT, COUNTERPARTY_PARTICIPANT],
        });
      }
      if (url.includes("/api/relationships/activate/check")) {
        return jsonResponse({ eligible: false, reasons: ["payout_account_missing", "agreement_missing"] });
      }
      if (url.includes("/api/relationships/accounts?")) {
        return jsonResponse({
          assignments: [
            {
              id: "assignment-1",
              usage: "funding",
              status: "active",
              financialAccount: { id: "acct-old", accountType: "bank_account", maskedLast4: "1111", institutionDisplayName: "Old Bank", status: "verified", individualProfileId: null, organizationId: "org-1" },
            },
          ],
        });
      }
      if (url.includes("/api/relationships/accounts/party")) {
        return jsonResponse({
          accounts: [
            { id: "acct-old", accountType: "bank_account", maskedLast4: "1111", institutionDisplayName: "Old Bank", status: "verified", individualProfileId: null, organizationId: "org-1" },
            { id: "acct-new", accountType: "bank_account", maskedLast4: "2222", institutionDisplayName: "New Bank", status: "verified", individualProfileId: null, organizationId: "org-1" },
          ],
        });
      }
      if (url.includes("/api/relationships/accounts/replace") && init?.method === "POST") {
        if (!replaced) {
          return jsonResponse({ status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required before replacing a funding or payout account." }, false);
        }
        return jsonResponse({ assignment: { id: "assignment-2" } });
      }
      if (url.includes("/api/auth/mfa/status")) return jsonResponse({ enrolled: true, methods: ["totp"] });
      if (url.includes("/api/auth/mfa/step-up/initiate")) return jsonResponse({ status: "ok" });
      if (url.includes("/api/auth/mfa/step-up/verify")) {
        replaced = true;
        return jsonResponse({ passed: true });
      }
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<ConnectionDetail />);
    await waitFor(() => expect(screen.getByLabelText(/select account for pay from \(funding\)/i)).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText(/select account for pay from \(funding\)/i), "acct-new");
    await user.click(screen.getByRole("button", { name: /^replace$/i }));

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/code from your authenticator app/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => {
      const replaceCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/relationships/accounts/replace"));
      expect(replaceCalls).toHaveLength(2);
    });
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
