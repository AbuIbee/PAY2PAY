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
      return jsonResponse({
        slots: [
          { usage: "funding", mine: false, assignmentId: null, status: null, ready: false, account: null },
          { usage: "payout", mine: true, assignmentId: null, status: null, ready: false, account: null },
        ],
      });
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
   * Privacy remediation (connection P2P-EZ2R-V3MM): the connection page must never render the
   * counterparty's bank name or last four — only a readiness chip. "me" here is the creditor (payout
   * slot is mine); the debtor's funding slot must show as "Funding account: Not ready" with no bank
   * details, even though the server-shaped fixture below never even offers this component that
   * account data (mirroring what the real, redacted API response looks like).
   */
  it("never renders counterparty bank details — only a readiness status", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return jsonResponse({ id: "me", email: "me@example.com" });
      if (url.includes("/api/relationships/detail")) {
        return jsonResponse({
          relationship: { id: "rel-1", status: "financial_accounts_ready", currentAgreementId: null, createdAt: "2026-01-01T00:00:00.000Z" },
          participants: [BUSINESS_PARTICIPANT, COUNTERPARTY_PARTICIPANT],
        });
      }
      if (url.includes("/api/relationships/activate/check")) {
        return jsonResponse({ eligible: false, reasons: ["agreement_missing"] });
      }
      if (url.includes("/api/relationships/accounts?")) {
        return jsonResponse({
          slots: [
            { usage: "funding", mine: false, assignmentId: "assignment-debtor", status: "active", ready: true, account: null },
            {
              usage: "payout",
              mine: true,
              assignmentId: "assignment-1",
              status: "active",
              ready: true,
              account: { id: "acct-mine", accountType: "bank_account", maskedLast4: "0808", institutionDisplayName: "Bank of America", status: "verified" },
            },
          ],
        });
      }
      if (url.includes("/api/relationships/accounts/party")) {
        return jsonResponse({
          accounts: [{ id: "acct-mine", accountType: "bank_account", maskedLast4: "0808", institutionDisplayName: "Bank of America", status: "verified", individualProfileId: null, organizationId: "org-1" }],
        });
      }
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectionDetail />);
    await waitFor(() => expect(screen.getByText("Your payment account")).toBeInTheDocument());

    // My own slot (payout, since "me" is the creditor here) shows full bank detail.
    expect(screen.getAllByText(/Bank of America/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/0808/).length).toBeGreaterThan(0);

    // The counterparty's slot (funding, owned by the debtor) shows readiness only.
    expect(screen.getByText("Funding account:")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText(/Chase/)).not.toBeInTheDocument();
    expect(screen.queryByText(/5218/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ending 5218/)).not.toBeInTheDocument();
  });

  /**
   * SPRINT_20_ClosedBetaReadiness (P0): replaceAccount gained a fresh-MFA-step-up requirement in
   * Sprint 19, but this handler previously called apiFetch directly with no step-up handling — a
   * real user replacing a funding/payout account would hit a raw, unhandled 403. This proves the
   * fix: the step-up dialog appears, and verification retries the original replace request.
   *
   * "me" is the creditor (payout is mine) — the payout slot is the one this test replaces, matching
   * the required ownership model (only the creditor may manage the payout slot).
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
        return jsonResponse({ eligible: false, reasons: ["agreement_missing"] });
      }
      if (url.includes("/api/relationships/accounts?")) {
        return jsonResponse({
          slots: [
            { usage: "funding", mine: false, assignmentId: null, status: null, ready: false, account: null },
            {
              usage: "payout",
              mine: true,
              assignmentId: "assignment-1",
              status: "active",
              ready: true,
              account: { id: "acct-old", accountType: "bank_account", maskedLast4: "1111", institutionDisplayName: "Old Bank", status: "verified" },
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
    await waitFor(() => expect(screen.getByLabelText(/select account for receive to \(payout\)/i)).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText(/select account for receive to \(payout\)/i), "acct-new");
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
