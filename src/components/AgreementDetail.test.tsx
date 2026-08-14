import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgreementDetail } from "./AgreementDetail";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams({ id: "agreement-1" }),
}));

const BASE_TERMS = {
  category: "personal_loan",
  description: "Loan for car repair",
  originalAmountMinorUnits: 100000,
  previousPaymentsMinorUnits: 0,
  currentPrincipalMinorUnits: 100000,
  firstPaymentMinorUnits: 10000,
  installmentAmountMinorUnits: 10000,
  firstPaymentDate: "2026-09-01",
  finalPaymentMinorUnits: 10000,
  numberOfInstallments: 9,
  earlyPayoffTerms: "Allowed anytime.",
  hardshipRules: "Case by case.",
  partialPaymentRules: "Allowed.",
  settlementRules: "Negotiable.",
  disputeProcedure: "Contact support.",
};

function detailBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "agreement-1",
    status: "active",
    currency: "USD",
    relationshipShape: "P2P",
    creditor: { kind: "personal", id: "profile-creditor" },
    debtor: { kind: "personal", id: "profile-debtor" },
    version: {
      id: "version-1",
      versionNumber: 1,
      frequency: "monthly",
      feeAllocation: "split_evenly",
      terms: BASE_TERMS,
      creditorSignedAt: "2026-08-01T00:00:00.000Z",
      debtorSignedAt: "2026-08-01T00:00:00.000Z",
      signedAt: "2026-08-01T00:00:00.000Z",
      documentHash: "hash",
    },
    schedule: [{ sequenceNumber: 0, dueDate: "2026-09-01", amountMinorUnits: 10000 }],
    ...overrides,
  };
}

function mockFetchByUrl(handlers: Record<string, { status?: number; body: unknown }>) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = Object.entries(handlers).find(([key]) => url.includes(key));
    if (!match) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    const [, entry] = match;
    const status = entry.status ?? 200;
    return Promise.resolve({ ok: status < 400, status, json: async () => entry.body });
  });
}

describe("AgreementDetail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the restricted witness view when the party-only detail fetch returns 403", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "/api/agreements/detail": { status: 403, body: { status: "error", code: "FORBIDDEN", message: "not a party" } },
        "/api/agreements/witnesses/view": {
          body: {
            agreement: { id: "agreement-1", status: "active", currency: "USD" },
            version: { id: "version-1", versionNumber: 1, terms: BASE_TERMS, signedAt: "2026-08-01T00:00:00.000Z" },
            schedule: [{ sequenceNumber: 0, dueDate: "2026-09-01", amountMinorUnits: 10000 }],
          },
        },
        "/api/agreements/witnesses?": { body: { witnesses: [] } },
      }),
    );

    render(<AgreementDetail />);

    expect(await screen.findByText("Witness view")).toBeInTheDocument();
    expect(
      screen.getByText(/financial account and identity details are never shown here/i),
    ).toBeInTheDocument();
  });

  it("labels evidence uploaded after signing distinctly from pre-signing evidence", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "/api/agreements/detail": { body: detailBody() },
        "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
        "/api/agreements/evidence?": {
          body: {
            evidence: [
              {
                id: "ev-1",
                documentType: "receipt",
                description: null,
                isPostSigning: true,
                visibility: "shared",
                sharedWithWitnesses: false,
                disputeFlag: false,
                withdrawalState: "active",
                uploadedAt: "2026-08-10T00:00:00.000Z",
              },
            ],
          },
        },
        "/api/agreements/witnesses?": { body: { witnesses: [] } },
        "/api/agreements/amendments?": { body: { amendments: [] } },
        "/api/agreements/partial-payments?": { body: { requests: [] } },
        "/api/agreements/settlements?": { body: { proposals: [] } },
        "/api/agreements/disputes?": { body: { disputes: [] } },
      }),
    );

    render(<AgreementDetail />);

    expect(await screen.findByText(/added after signing/i)).toBeInTheDocument();
  });

  it("settlement status chips never show the same label/tone for 'accepted' and 'completed'", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "/api/agreements/detail": { body: detailBody() },
        "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
        "/api/agreements/evidence?": { body: { evidence: [] } },
        "/api/agreements/witnesses?": { body: { witnesses: [] } },
        "/api/agreements/amendments?": { body: { amendments: [] } },
        "/api/agreements/partial-payments?": { body: { requests: [] } },
        "/api/agreements/settlements?": {
          body: {
            proposals: [
              {
                id: "settle-accepted",
                status: "awaiting_payment",
                proposingPartyRole: "debtor",
                preSettlementBalanceMinorUnits: 100000,
                settlementAmountMinorUnits: 50000,
                forgivenAmountMinorUnits: 50000,
                deadline: "2026-09-01",
                paymentMode: "one_time",
                completedAt: null,
                createdAt: "2026-08-01T00:00:00.000Z",
              },
              {
                id: "settle-completed",
                status: "completed",
                proposingPartyRole: "debtor",
                preSettlementBalanceMinorUnits: 100000,
                settlementAmountMinorUnits: 50000,
                forgivenAmountMinorUnits: 50000,
                deadline: "2026-09-01",
                paymentMode: "one_time",
                completedAt: "2026-08-15T00:00:00.000Z",
                createdAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          },
        },
        "/api/agreements/disputes?": { body: { disputes: [] } },
      }),
    );

    render(<AgreementDetail />);
    await screen.findByText("Settlements");

    // "Accepted" must never visually equal "Paid"/"Completed" — distinct labels, and the forgiven
    // amount is only ever rendered for the completed proposal.
    expect(screen.getByText(/accepted.*payment required/i)).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText(/forgiveness applies only once payment is completed/i)).toBeInTheDocument();
    expect(screen.getAllByText(/forgiven: \$500\.00/i)).toHaveLength(1);
  });

  it("opens the step-up challenge when signing returns STEP_UP_REQUIRED, instead of showing a raw error", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "/api/agreements/detail": {
          body: detailBody({ status: "awaiting_signatures", version: { ...detailBody().version, creditorSignedAt: null, debtorSignedAt: null } }),
        },
        "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
        "/api/agreements/evidence?": { body: { evidence: [] } },
        "/api/agreements/witnesses?": { body: { witnesses: [] } },
        "/api/agreements/amendments?": { body: { amendments: [] } },
        "/api/agreements/partial-payments?": { body: { requests: [] } },
        "/api/agreements/settlements?": { body: { proposals: [] } },
        "/api/agreements/disputes?": { body: { disputes: [] } },
        "/api/agreements/sign": {
          status: 403,
          body: { status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required before signing." },
        },
        "/api/auth/mfa/status": { body: { enrolled: true, methods: ["totp"] } },
      }),
    );

    render(<AgreementDetail />);
    const signButton = await screen.findByRole("button", { name: /sign this agreement/i });
    await user.click(signButton);

    await waitFor(() => expect(screen.getByText(/verify it's you/i)).toBeInTheDocument());
  });
});
