import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgreementDetail } from "./AgreementDetail";

const mockRouterPush = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams({ id: "agreement-1" }),
  useRouter: () => ({ push: mockRouterPush }),
  usePathname: () => "/agreements/detail",
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
    mockRouterPush.mockClear();
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
    expect(screen.getByText("Step 4 — Review & signatures")).toBeInTheDocument();
  });

  const READY_PROGRESS_STEPS = [
    { key: "details_terms", label: "Agreement details & terms", status: "complete", description: "x", cta: null },
    { key: "acceptance", label: "Review & acceptance", status: "complete", description: "x", cta: null },
    { key: "payment_method", label: "Payment method", status: "complete", statusText: "Payment method — Complete", description: "Payment accounts are ready for this agreement.", cta: null },
    { key: "signatures", label: "Review & signatures", status: "complete", description: "x", cta: null },
    {
      key: "active",
      label: "Agreement active",
      status: "waiting",
      statusText: "Next payment scheduled",
      description: "Payment of $100.00 is due 2026-09-01.",
      cta: { label: "Make payment", href: "/agreements/detail?id=agreement-1#make-payment" },
    },
  ];

  describe("Restore agreement payment functionality: Make Payment section", () => {
    it("shows the debtor an obvious payment action with amount/due date/remaining balance/funding source before submission, and shows the real returned status afterward — never an optimistic success", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockImplementation(
        mockFetchByUrl({
          "/api/agreements/detail": { body: detailBody({ status: "active" }) },
          "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-debtor" } },
          "/api/agreements/evidence?": { body: { evidence: [] } },
          "/api/agreements/witnesses?": { body: { witnesses: [] } },
          "/api/agreements/amendments?": { body: { amendments: [] } },
          "/api/agreements/partial-payments?": { body: { requests: [] } },
          "/api/agreements/settlements?": { body: { proposals: [] } },
          "/api/agreements/disputes?": { body: { disputes: [] } },
          "/api/agreements/progress": {
            body: {
              agreementId: "agreement-1",
              myRole: "debtor",
              status: "active",
              steps: READY_PROGRESS_STEPS,
              primaryAction: { label: "Next payment scheduled", description: "Payment of $100.00 is due 2026-09-01.", cta: null },
              actionableForMeCount: 0,
            },
          },
          "/api/agreements/payment-setup/next-payment": {
            body: {
              nextInstallment: { id: "installment-1", sequenceNumber: 0, dueDate: "2026-09-01", amountMinorUnits: 10000 },
              remainingBalanceMinorUnits: 90000,
              fundingAccountLabel: "Test Bank ····4242",
              recipientDisplayName: "Jordan Creditor",
            },
          },
          "/api/ach/payments/manual": { body: { id: "payment-1", status: "scheduled" } },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      render(<AgreementDetail />);

      expect(await screen.findByRole("heading", { name: "Make a payment" })).toBeInTheDocument();
      expect(screen.getByText("Pay to: Jordan Creditor")).toBeInTheDocument();
      expect(screen.getByText("Amount due: $100.00")).toBeInTheDocument();
      expect(screen.getByText(/Remaining balance: \$900\.00/)).toBeInTheDocument();
      expect(screen.getByText(/Funding source: Test Bank ····4242/)).toBeInTheDocument();
      expect(screen.getByText(/Payment method: ACH bank transfer/)).toBeInTheDocument();
      expect(screen.getByText(/Fee: None/)).toBeInTheDocument();
      // No false claim of automation — this system is manual/debtor-initiated (no due-date cron exists).
      expect(screen.getByText(/not collected automatically/i)).toBeInTheDocument();

      // First click never submits — it opens the explicit review/confirm step.
      await user.click(screen.getByRole("button", { name: "Review payment" }));
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/ach/payments/manual"))).toBe(false);
      expect(await screen.findByText(/Confirm payment of \$100\.00 to Jordan Creditor/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Confirm payment" }));

      const manualCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/ach/payments/manual"));
      if (!manualCall) throw new Error("expected a manual payment call");
      const [, init] = manualCall;
      const sentBody = JSON.parse((init as RequestInit).body as string);
      expect(sentBody).toMatchObject({
        agreementId: "agreement-1",
        payer: { profileKind: "personal", profileId: "profile-debtor" },
        recipient: { profileKind: "personal", profileId: "profile-creditor" },
        amountMinorUnits: 10000,
        currency: "USD",
        installmentScheduleItemId: "installment-1",
      });

      // Never an optimistic "Payment complete" — shows only the real provider-consistent status returned.
      expect(await screen.findByText(/Payment submitted — status: scheduled/)).toBeInTheDocument();
      expect(screen.queryByText(/payment complete/i)).not.toBeInTheDocument();
    });

    it("Fix the 'Make payment' button: 'Cancel' on the confirmation step backs out without submitting, and clicking 'Confirm payment' twice never submits twice", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockImplementation(
        mockFetchByUrl({
          "/api/agreements/detail": { body: detailBody({ status: "active" }) },
          "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-debtor" } },
          "/api/agreements/evidence?": { body: { evidence: [] } },
          "/api/agreements/witnesses?": { body: { witnesses: [] } },
          "/api/agreements/amendments?": { body: { amendments: [] } },
          "/api/agreements/partial-payments?": { body: { requests: [] } },
          "/api/agreements/settlements?": { body: { proposals: [] } },
          "/api/agreements/disputes?": { body: { disputes: [] } },
          "/api/agreements/progress": {
            body: { agreementId: "agreement-1", myRole: "debtor", status: "active", steps: READY_PROGRESS_STEPS, primaryAction: { label: "x", description: "x", cta: null }, actionableForMeCount: 0 },
          },
          "/api/agreements/payment-setup/next-payment": {
            body: {
              nextInstallment: { id: "installment-1", sequenceNumber: 0, dueDate: "2026-09-01", amountMinorUnits: 10000 },
              remainingBalanceMinorUnits: 90000,
              fundingAccountLabel: "Test Bank ····4242",
              recipientDisplayName: "Jordan Creditor",
            },
          },
          "/api/ach/payments/manual": { body: { id: "payment-1", status: "scheduled" } },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      render(<AgreementDetail />);

      function manualCallCount() {
        return fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/ach/payments/manual")).length;
      }

      await screen.findByRole("heading", { name: "Make a payment" });
      await user.click(screen.getByRole("button", { name: "Review payment" }));
      await screen.findByText(/Confirm payment of \$100\.00/);

      // Cancel backs out without ever calling the payment API.
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getByRole("button", { name: "Review payment" })).toBeInTheDocument();
      expect(manualCallCount()).toBe(0);

      // Re-entering and confirming for real only submits once, even if clicked twice in quick succession.
      await user.click(screen.getByRole("button", { name: "Review payment" }));
      const confirmButton = await screen.findByRole("button", { name: "Confirm payment" });
      await Promise.all([user.click(confirmButton), user.click(confirmButton)]);
      await screen.findByText(/Payment submitted/);
      expect(manualCallCount()).toBe(1);
    });

    it("never shows the Make Payment section to the creditor", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetchByUrl({
          "/api/agreements/detail": { body: detailBody({ status: "active" }) },
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
              status: "active",
              steps: READY_PROGRESS_STEPS,
              primaryAction: { label: "Next payment scheduled", description: "x", cta: null },
              actionableForMeCount: 0,
            },
          },
          "/api/agreements/payment-setup/next-payment": {
            body: { nextInstallment: { id: "installment-1", sequenceNumber: 0, dueDate: "2026-09-01", amountMinorUnits: 10000 }, remainingBalanceMinorUnits: 90000, fundingAccountLabel: null },
          },
        }),
      );

      render(<AgreementDetail />);
      await screen.findByText("Agreement progress");
      expect(screen.queryByRole("heading", { name: "Make a payment" })).not.toBeInTheDocument();
    });

    it("does not show Make Payment while payment setup is still incomplete", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetchByUrl({
          "/api/agreements/detail": { body: detailBody({ status: "first_payment_pending" }) },
          "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-debtor" } },
          "/api/agreements/evidence?": { body: { evidence: [] } },
          "/api/agreements/witnesses?": { body: { witnesses: [] } },
          "/api/agreements/amendments?": { body: { amendments: [] } },
          "/api/agreements/partial-payments?": { body: { requests: [] } },
          "/api/agreements/settlements?": { body: { proposals: [] } },
          "/api/agreements/disputes?": { body: { disputes: [] } },
          "/api/agreements/progress": {
            body: {
              agreementId: "agreement-1",
              myRole: "debtor",
              status: "first_payment_pending",
              steps: [
                ...READY_PROGRESS_STEPS.slice(0, 2),
                {
                  key: "payment_method",
                  label: "Payment method",
                  status: "action_required",
                  statusText: "Payment setup required",
                  description: "Add a payment method so payments can be made under this agreement.",
                  cta: { label: "Set up payment method", href: "/payment-methods" },
                },
                READY_PROGRESS_STEPS[3],
                READY_PROGRESS_STEPS[4],
              ],
              primaryAction: { label: "Set up payment method", description: "x", cta: { label: "Set up payment method", href: "/payment-methods" } },
              actionableForMeCount: 1,
            },
          },
          "/api/agreements/payment-setup/next-payment": {
            body: { nextInstallment: null, remainingBalanceMinorUnits: null, fundingAccountLabel: null },
          },
        }),
      );

      render(<AgreementDetail />);
      await screen.findByText("Agreement progress");
      expect(screen.queryByRole("heading", { name: "Make a payment" })).not.toBeInTheDocument();
    });
  });

  describe("Agreement page ordering remediation: Amendments modifies the agreement itself and must appear before supporting evidence/witness material", () => {
    it("Payment schedule has a heading, the table sits beneath it, Amendments comes immediately after, then Evidence & witnesses — with no duplicate Amendments section", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetchByUrl({
          "/api/agreements/detail": { body: detailBody({ status: "active" }) },
          "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
          "/api/agreements/evidence?": { body: { evidence: [] } },
          "/api/agreements/witnesses?": { body: { witnesses: [] } },
          "/api/agreements/amendments?": { body: { amendments: [] } },
          "/api/agreements/partial-payments?": { body: { requests: [] } },
          "/api/agreements/settlements?": { body: { proposals: [] } },
          "/api/agreements/disputes?": { body: { disputes: [] } },
        }),
      );

      render(<AgreementDetail />);
      await screen.findByText("Payment schedule");

      const headings = screen.getAllByRole("heading").map((h) => h.textContent);
      const scheduleIndex = headings.indexOf("Payment schedule");
      const amendmentsIndex = headings.indexOf("Amendments");
      const evidenceIndex = headings.indexOf("Evidence & witnesses");
      expect(scheduleIndex).toBeGreaterThanOrEqual(0);
      expect(amendmentsIndex).toBeGreaterThan(scheduleIndex);
      expect(evidenceIndex).toBeGreaterThan(amendmentsIndex);
      // Immediately after — no other heading in between.
      expect(amendmentsIndex).toBe(scheduleIndex + 1);
      expect(evidenceIndex).toBe(amendmentsIndex + 1);

      // Never duplicated.
      expect(headings.filter((h) => h === "Amendments").length).toBe(1);
      expect(headings.filter((h) => h === "Evidence & witnesses").length).toBe(1);

      // The schedule table itself is directly beneath the heading (same card).
      const scheduleHeading = screen.getByRole("heading", { name: "Payment schedule" });
      const scheduleCard = scheduleHeading.closest(".card");
      expect(scheduleCard?.querySelector("table")).toBeTruthy();
    });
  });

  describe("Receiving-party amendment review remediation: the recipient must see actual proposed terms before deciding", () => {
    const PROPOSED_TERMS = {
      ...BASE_TERMS,
      currentPrincipalMinorUnits: 65000,
      installmentAmountMinorUnits: 7500,
      firstPaymentDate: "2026-09-15",
      finalPaymentMinorUnits: 7500,
      numberOfInstallments: 13,
    };

    function amendmentFixture(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: "amendment-1",
        changeType: "reduced_installment",
        status: "proposed",
        proposingPartyRole: "debtor",
        reason: "Lost overtime hours at work",
        requestedRelief: "Reduce installment to $75/month",
        proposedEffectiveDate: "2026-09-15",
        terms: PROPOSED_TERMS,
        frequency: "biweekly",
        feeAllocation: "creditor_pays",
        creditorSignedAt: null,
        debtorSignedAt: null,
        resultingVersionId: null,
        createdAt: "2026-08-20T00:00:00.000Z",
        ...overrides,
      };
    }

    it("shows 'View revised agreement' before Accept/Reject, and reveals the actual proposed terms (not just title/description) only once selected", async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        "fetch",
        mockFetchByUrl({
          "/api/agreements/detail": { body: detailBody({ status: "active" }) },
          "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
          "/api/agreements/evidence?": { body: { evidence: [] } },
          "/api/agreements/witnesses?": { body: { witnesses: [] } },
          "/api/agreements/amendments?": { body: { amendments: [amendmentFixture()] } },
          "/api/agreements/partial-payments?": { body: { requests: [] } },
          "/api/agreements/settlements?": { body: { proposals: [] } },
          "/api/agreements/disputes?": { body: { disputes: [] } },
          "/api/agreements/amendments/preview": {
            body: {
              schedule: [{ sequenceNumber: 0, dueDate: "2026-09-15", amountMinorUnits: 7500 }],
              finalPaymentMinorUnits: 7500,
              numberOfInstallments: 13,
            },
          },
        }),
      );

      render(<AgreementDetail />);
      const viewButton = await screen.findByRole("button", { name: "View revised agreement" });
      const buttons = screen.getAllByRole("button").map((b) => b.textContent);
      // "View revised agreement" must appear before Accept/Reject in DOM order.
      expect(buttons.indexOf("View revised agreement")).toBeLessThan(buttons.indexOf("Accept"));
      expect(buttons.indexOf("Accept")).toBeLessThan(buttons.indexOf("Reject"));

      // Not shown yet — only the title/description/proposer, matching the pre-fix behavior, until expanded.
      expect(screen.queryByText(/NOT YET EFFECTIVE/)).not.toBeInTheDocument();

      await user.click(viewButton);

      expect(await screen.findByText(/PROPOSED REVISED AGREEMENT — NOT YET EFFECTIVE/)).toBeInTheDocument();
      // Current vs proposed payment amount both visible and distinguishable.
      expect(screen.getByText("Payment amount")).toBeInTheDocument();
      expect(screen.getAllByText("$100.00").length).toBeGreaterThan(0);
      expect(screen.getAllByText("$75.00").length).toBeGreaterThan(0);
      expect(screen.getByText("Frequency")).toBeInTheDocument();
      expect(screen.getByText("Every two weeks")).toBeInTheDocument();
      expect(screen.getByText("Remaining schedule")).toBeInTheDocument();
      expect(screen.getByText("13 payments")).toBeInTheDocument();

      // The proposed itemized schedule (lazily fetched) is also shown.
      expect(await screen.findByText("Proposed effective payment schedule")).toBeInTheDocument();

      // The complete proposed revised agreement (not just a numeric diff) is available too.
      await user.click(screen.getByText("Full proposed revised agreement text"));
      expect(screen.getByText(/Early payoff terms:/)).toBeInTheDocument();
      expect(screen.getByText(/Hardship rules:/)).toBeInTheDocument();
      expect(screen.getByText(/Dispute procedure:/)).toBeInTheDocument();
    });

    it("never lets Accept apply to an amendment whose terms could not be loaded", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetchByUrl({
          "/api/agreements/detail": { body: detailBody({ status: "active" }) },
          "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
          "/api/agreements/evidence?": { body: { evidence: [] } },
          "/api/agreements/witnesses?": { body: { witnesses: [] } },
          "/api/agreements/amendments?": { body: { amendments: [amendmentFixture({ terms: null })] } },
          "/api/agreements/partial-payments?": { body: { requests: [] } },
          "/api/agreements/settlements?": { body: { proposals: [] } },
          "/api/agreements/disputes?": { body: { disputes: [] } },
        }),
      );

      render(<AgreementDetail />);
      const acceptButton = await screen.findByRole("button", { name: "Accept" });
      expect(acceptButton).toBeDisabled();
    });

    it("shows a Sign amendment action once accepted (awaiting_signatures), and calls the real sign endpoint", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockImplementation(
        mockFetchByUrl({
          "/api/agreements/detail": { body: detailBody({ status: "active" }) },
          "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
          "/api/agreements/evidence?": { body: { evidence: [] } },
          "/api/agreements/witnesses?": { body: { witnesses: [] } },
          "/api/agreements/amendments?": {
            body: { amendments: [amendmentFixture({ status: "awaiting_signatures", creditorSignedAt: null, debtorSignedAt: "2026-08-21T00:00:00.000Z" })] },
          },
          "/api/agreements/partial-payments?": { body: { requests: [] } },
          "/api/agreements/settlements?": { body: { proposals: [] } },
          "/api/agreements/disputes?": { body: { disputes: [] } },
          "/api/agreements/amendments/sign": { body: { status: "signed" } },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      render(<AgreementDetail />);
      await user.click(await screen.findByRole("button", { name: "Sign amendment" }));

      const signCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/agreements/amendments/sign"));
      if (!signCall) throw new Error("expected a sign call");
      const [, init] = signCall;
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ amendmentId: "amendment-1" });
    });

    it("rejecting leaves no Sign action and no revised terms applied — the current agreement remains unchanged", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetchByUrl({
          "/api/agreements/detail": { body: detailBody({ status: "active" }) },
          "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
          "/api/agreements/evidence?": { body: { evidence: [] } },
          "/api/agreements/witnesses?": { body: { witnesses: [] } },
          "/api/agreements/amendments?": { body: { amendments: [amendmentFixture({ status: "rejected" })] } },
          "/api/agreements/partial-payments?": { body: { requests: [] } },
          "/api/agreements/settlements?": { body: { proposals: [] } },
          "/api/agreements/disputes?": { body: { disputes: [] } },
        }),
      );

      render(<AgreementDetail />);
      await screen.findByText("Rejected");
      expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Sign amendment" })).not.toBeInTheDocument();
      // The original amount is still what's shown for the executed agreement.
      expect(screen.getByText(/Original amount: \$1,000\.00/)).toBeInTheDocument();
    });
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

  it("Agreement Lifecycle V2 UAT (Defect 3): Delete Draft asks for confirmation, then navigates to /agreements on success", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation(
      mockFetchByUrl({
        "/api/agreements/detail": { body: detailBody({ status: "draft" }) },
        "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
        "/api/agreements/evidence?": { body: { evidence: [] } },
        "/api/agreements/witnesses?": { body: { witnesses: [] } },
        "/api/agreements/amendments?": { body: { amendments: [] } },
        "/api/agreements/partial-payments?": { body: { requests: [] } },
        "/api/agreements/settlements?": { body: { proposals: [] } },
        "/api/agreements/disputes?": { body: { disputes: [] } },
        "/api/agreements/delete-draft": { body: { status: "deleted" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AgreementDetail />);
    const deleteButton = await screen.findByRole("button", { name: /^delete draft$/i });
    await user.click(deleteButton);

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/agreements"));
    confirmSpy.mockRestore();
  });

  it("Agreement Lifecycle V2 UAT (Defect 3): declining the Delete Draft confirmation dialog never calls the API", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation(
      mockFetchByUrl({
        "/api/agreements/detail": { body: detailBody({ status: "draft" }) },
        "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
        "/api/agreements/evidence?": { body: { evidence: [] } },
        "/api/agreements/witnesses?": { body: { witnesses: [] } },
        "/api/agreements/amendments?": { body: { amendments: [] } },
        "/api/agreements/partial-payments?": { body: { requests: [] } },
        "/api/agreements/settlements?": { body: { proposals: [] } },
        "/api/agreements/disputes?": { body: { disputes: [] } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AgreementDetail />);
    const deleteButton = await screen.findByRole("button", { name: /^delete draft$/i });
    await user.click(deleteButton);

    expect(confirmSpy).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/agreements/delete-draft"))).toBe(false);
    expect(mockRouterPush).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("Agreement Lifecycle V2 UAT (Defect 3): Cancel Agreement requires a reason and shows the exact required explanatory text before confirming", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation(
      mockFetchByUrl({
        "/api/agreements/detail": { body: detailBody({ status: "awaiting_signatures" }) },
        "/api/profiles/active": { body: { kind: "personal", personalProfileId: "profile-creditor" } },
        "/api/agreements/evidence?": { body: { evidence: [] } },
        "/api/agreements/witnesses?": { body: { witnesses: [] } },
        "/api/agreements/amendments?": { body: { amendments: [] } },
        "/api/agreements/partial-payments?": { body: { requests: [] } },
        "/api/agreements/settlements?": { body: { proposals: [] } },
        "/api/agreements/disputes?": { body: { disputes: [] } },
        "/api/agreements/cancel": { body: { status: "mutually_canceled" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgreementDetail />);
    const openButton = await screen.findByRole("button", { name: /^cancel agreement$/i });
    await user.click(openButton);

    expect(screen.getByText(/this agreement has not been fully executed/i)).toBeInTheDocument();
    expect(screen.getByText(/historical record will be retained/i)).toBeInTheDocument();

    const confirmButton = screen.getByRole("button", { name: /confirm cancellation/i });
    expect(confirmButton).toBeDisabled(); // no reason entered yet

    await user.type(screen.getByLabelText(/reason \(required\)/i), "Changed my mind.");
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/agreements/cancel"))).toBe(true);
    });
  });
});
