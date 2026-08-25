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

  it("Problem 2 remediation: shows an inline schedule-revision form (not a dead-end error) when signing fails because the first payment date has already passed, and successfully proposing a new date returns to normal signing", async () => {
    const user = userEvent.setup();
    let revised = false;
    const staleDetailBody = detailBody({
      status: "awaiting_signatures",
      version: { ...detailBody().version, creditorSignedAt: null, debtorSignedAt: null },
    });
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/agreements/detail")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => staleDetailBody });
      }
      if (url.includes("/api/agreements/sign")) {
        return revised
          ? Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "awaiting_signatures", signatureEventId: "sig-1", pdfGenerated: false }) })
          : Promise.resolve({
              ok: false,
              status: 400,
              json: async () => ({
                status: "error",
                code: "SCHEDULE_REVISION_REQUIRED",
                message: "The proposed first payment date (2026-01-01) has already passed. This agreement's schedule must be revised before it can be signed.",
              }),
            });
      }
      if (url.includes("/api/agreements/revise-first-payment-date")) {
        revised = true;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "awaiting_signatures", firstPaymentDate: "2026-12-01" }) });
      }
      const match = Object.entries({
        "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
        "/api/agreements/evidence?": { body: { evidence: [] } },
        "/api/agreements/witnesses?": { body: { witnesses: [] } },
        "/api/agreements/amendments?": { body: { amendments: [] } },
        "/api/agreements/partial-payments?": { body: { requests: [] } },
        "/api/agreements/settlements?": { body: { proposals: [] } },
        "/api/agreements/disputes?": { body: { disputes: [] } },
      }).find(([key]) => url.includes(key));
      if (!match) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      return Promise.resolve({ ok: true, status: 200, json: async () => match[1].body });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AgreementDetail />);
    const signButton = await screen.findByRole("button", { name: /sign this agreement/i });
    await user.click(signButton);

    const dateInput = await screen.findByLabelText(/new first payment date/i);
    expect(screen.getByText(/already passed/i)).toBeInTheDocument();
    // A dead-end error would have no further control — this must offer a real, actionable form instead.
    expect(screen.queryByRole("button", { name: /^sign this agreement$/i })).not.toBeInTheDocument();

    await user.type(dateInput, "2026-12-01");
    await user.click(screen.getByRole("button", { name: /propose new date/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/agreements/revise-first-payment-date"))).toBe(true),
    );
    // Back to the normal signing state — the revision form is gone and the page reloaded successfully.
    await waitFor(() => expect(screen.getByRole("button", { name: /^sign this agreement$/i })).toBeInTheDocument());
  });

  it("Problem 3 remediation: renders the Agreement Progress panel from /api/agreements/progress", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "/api/agreements/detail": { body: detailBody({ status: "awaiting_signatures" }) },
        "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
        "/api/agreements/evidence?": { body: { evidence: [] } },
        "/api/agreements/witnesses?": { body: { witnesses: [] } },
        "/api/agreements/amendments?": { body: { amendments: [] } },
        "/api/agreements/partial-payments?": { body: { requests: [] } },
        "/api/agreements/settlements?": { body: { proposals: [] } },
        "/api/agreements/disputes?": { body: { disputes: [] } },
        "/api/agreements/progress": {
          body: {
            agreementId: "agreement-1",
            myRole: "creditor",
            status: "awaiting_signatures",
            steps: [
              { key: "details_terms", label: "Agreement details & terms", status: "complete", description: "x", cta: null },
              { key: "acceptance", label: "Review & acceptance", status: "complete", description: "x", cta: null },
              { key: "payment_method", label: "Payment method", status: "optional", description: "Not required for this agreement.", cta: null },
              { key: "identity_verification", label: "Identity verification", status: "complete", description: "x", cta: null },
              { key: "signatures", label: "Review & signatures", status: "action_required", description: "Review the agreement and sign to continue.", cta: null },
              { key: "active", label: "Agreement active", status: "not_started", description: "x", cta: null },
            ],
            primaryAction: { label: "Review and sign", description: "Review the agreement and sign to continue.", cta: null },
            actionableForMeCount: 1,
          },
        },
      }),
    );

    render(<AgreementDetail />);

    expect(await screen.findByText("Agreement progress")).toBeInTheDocument();
    expect(screen.getByText("Step 5 — Review & signatures")).toBeInTheDocument();
  });

  it("PRSprint 25: rejecting an agreement requires confirmation — declining the dialog never calls the API", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation(mockFetchByUrl({
      "/api/agreements/detail": { body: detailBody({ status: "awaiting_creditor_acceptance" }) },
      "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
      "/api/agreements/evidence?": { body: { evidence: [] } },
      "/api/agreements/witnesses?": { body: { witnesses: [] } },
      "/api/agreements/amendments?": { body: { amendments: [] } },
      "/api/agreements/partial-payments?": { body: { requests: [] } },
      "/api/agreements/settlements?": { body: { proposals: [] } },
      "/api/agreements/disputes?": { body: { disputes: [] } },
      "/api/agreements/decide": { body: { status: "rejected" } },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AgreementDetail />);
    const rejectButton = await screen.findByRole("button", { name: /^reject$/i });
    await user.click(rejectButton);

    expect(confirmSpy).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/agreements/decide"))).toBe(false);
  });

  it("Agreement Lifecycle V2: the debtor can request changes (not just acknowledge) at awaiting_debtor_acknowledgment, via the shared revise-terms path", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation(
      mockFetchByUrl({
        "/api/agreements/detail": { body: detailBody({ status: "awaiting_debtor_acknowledgment" }) },
        "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-debtor" } },
        "/api/agreements/evidence?": { body: { evidence: [] } },
        "/api/agreements/witnesses?": { body: { witnesses: [] } },
        "/api/agreements/amendments?": { body: { amendments: [] } },
        "/api/agreements/partial-payments?": { body: { requests: [] } },
        "/api/agreements/settlements?": { body: { proposals: [] } },
        "/api/agreements/disputes?": { body: { disputes: [] } },
        "/api/agreements/revise-terms": { body: { status: "awaiting_creditor_acceptance", versionNumber: 2 } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgreementDetail />);
    const requestChangesButton = await screen.findByRole("button", { name: /request changes/i });
    await user.click(requestChangesButton);

    const reasonField = await screen.findByLabelText(/why are you requesting changes/i);
    await user.type(reasonField, "I can only afford smaller installments.");
    await user.click(screen.getByRole("button", { name: /send requested changes/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/agreements/revise-terms"))).toBe(true);
    });
  });
});
