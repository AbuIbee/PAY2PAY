import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgreementCreateWizard } from "./AgreementCreateWizard";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

function mockFetchByUrl(handlers: Record<string, { status?: number; body: unknown }>) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = Object.entries(handlers).find(([key]) => url.includes(key));
    if (!match) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    const [, entry] = match;
    const status = entry.status ?? 200;
    return Promise.resolve({ ok: status < 400, status, json: async () => entry.body });
  });
}

describe("AgreementCreateWizard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
  });

  it("shows an empty state directing to Connections when the acting identity has no eligible relationships", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "/api/profiles": { body: { profiles: [{ kind: "personal", personalProfileId: "p1", displayName: "Jane Doe" }] } },
        "/api/relationships?": { body: { relationships: [] } },
      }),
    );

    render(<AgreementCreateWizard />);

    expect(await screen.findByText(/no eligible connections/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /invite a counterparty/i })).toHaveAttribute("href", "/connections/invite");
  });

  it("Agreement Lifecycle V2 (Next: Terms regression): excludes a still-pending ('invited') connection from the picker, instead of offering a selection that dead-ends with Next: Terms permanently disabled", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "/api/profiles": { body: { profiles: [{ kind: "personal", personalProfileId: "p1", displayName: "Jane Doe" }] } },
        "/api/relationships?": {
          body: { relationships: [{ id: "rel-invited", status: "invited", currentAgreementId: null }] },
        },
      }),
    );

    render(<AgreementCreateWizard />);

    // Awaited directly (not a separate sync follow-up) — "No eligible connections" is also what
    // renders on the very first tick before the relationships fetch resolves, so only this specific,
    // fetch-derived text proves the async data actually landed.
    expect(await screen.findByText(/aren.t ready for a new agreement yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no eligible connections/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/connection/i)).not.toBeInTheDocument();
  });

  it("Agreement Lifecycle V2: also excludes a closed/cancelled/restricted/suspended connection from the picker", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "/api/profiles": { body: { profiles: [{ kind: "personal", personalProfileId: "p1", displayName: "Jane Doe" }] } },
        "/api/relationships?": {
          body: {
            relationships: [
              { id: "rel-closed", status: "closed", currentAgreementId: null },
              { id: "rel-restricted", status: "restricted", currentAgreementId: null },
            ],
          },
        },
      }),
    );

    render(<AgreementCreateWizard />);
    expect(await screen.findByText(/aren.t ready for a new agreement yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no eligible connections/i)).toBeInTheDocument();
  });

  it("Next: Terms regression (production follow-up): a listed connection that turns out to be participant-incomplete is dropped from the picker instead of leaving Next: Terms permanently disabled with no way forward", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "/api/profiles": { body: { profiles: [{ kind: "personal", personalProfileId: "p1", displayName: "Jane Doe" }] } },
        "/api/relationships?": { body: { relationships: [{ id: "rel-broken", status: "financial_accounts_ready", currentAgreementId: null }] } },
        "/api/relationships/detail": {
          body: {
            relationship: { id: "rel-broken" },
            // Only one participant ever came back — the exact production data shape found on a
            // relationship that reached this status without a real accept() ever running.
            participants: [{ id: "part-1", relationshipId: "rel-broken", individualProfileId: "p1", organizationId: null, role: "creditor", representedByUserId: "user-1" }],
          },
        },
      }),
    );

    render(<AgreementCreateWizard />);

    const select = await screen.findByLabelText(/connection/i);
    await user.selectOptions(select, "rel-broken");

    expect(await screen.findByText(/doesn.t have two confirmed participants yet/i)).toBeInTheDocument();
    // The broken connection is gone — nothing left to (mis)select, so "No eligible connections"
    // is now what the user sees, instead of a stuck picker with a permanently-disabled button.
    expect(await screen.findByText(/no eligible connections/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/connection/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next: terms/i })).toBeDisabled();
  });

  it("derives both parties' roles from the selected connection and creates + links a draft agreement", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "/api/profiles": { body: { profiles: [{ kind: "personal", personalProfileId: "p1", displayName: "Jane Doe" }] } },
        "/api/relationships?": { body: { relationships: [{ id: "rel-1", status: "financial_accounts_ready", currentAgreementId: null }] } },
        "/api/relationships/detail": {
          body: {
            relationship: { id: "rel-1" },
            participants: [
              { id: "part-1", relationshipId: "rel-1", individualProfileId: "p1", organizationId: null, role: "creditor", representedByUserId: "user-1" },
              { id: "part-2", relationshipId: "rel-1", individualProfileId: "p2", organizationId: null, role: "debtor", representedByUserId: "user-2" },
            ],
          },
        },
        "/api/agreements": { status: 201, body: { id: "agreement-new" } },
        "/api/relationships/link-agreement": { body: { relationship: { id: "rel-1" } } },
      }),
    );

    render(<AgreementCreateWizard />);

    const select = await screen.findByLabelText(/connection/i);
    await user.selectOptions(select, "rel-1");

    expect(await screen.findByText(/you are/i)).toBeInTheDocument();
    expect(screen.getByText(/receiving repayment \(creditor\)/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /next: terms/i }));
    await user.type(screen.getByLabelText(/^category$/i), "personal_loan");
    await user.type(screen.getByLabelText(/what is this repayment for/i), "Test loan");
    await user.type(screen.getByLabelText(/original amount/i), "500");
    await user.type(screen.getByLabelText(/first payment amount/i), "50");
    await user.type(screen.getByLabelText(/first payment date/i), "2026-10-01");
    await user.type(screen.getByLabelText(/recurring installment amount/i), "50");
    await user.type(screen.getByLabelText(/paid off early/i), "Anytime");
    await user.type(screen.getByLabelText(/can't be made on time/i), "Case by case");
    await user.type(screen.getByLabelText(/partial payments allowed/i), "Allowed");
    await user.type(screen.getByLabelText(/settled for less than the full balance/i), "Negotiable");
    await user.type(screen.getByLabelText(/how will disagreements be handled/i), "Contact support");

    await user.click(screen.getByRole("button", { name: /next: review/i }));
    await user.click(screen.getByRole("button", { name: /create draft agreement/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/agreements/detail?id=agreement-new"));
  });
});
