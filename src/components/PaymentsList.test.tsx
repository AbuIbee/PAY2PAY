import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentsList } from "./PaymentsList";

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as Response;
}

function buildFetchMock(payments: Record<string, unknown[]>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/profiles/active")) {
      return jsonResponse({ kind: "personal", personalProfileId: "profile-1", displayName: "Me" });
    }
    if (url.includes("/api/agreements?")) {
      return jsonResponse({
        agreements: Object.keys(payments).map((id) => ({ id, status: "active", currency: "USD", relationshipShape: "P2P", createdAt: new Date().toISOString() })),
      });
    }
    if (url.includes("/api/payments/by-agreement")) {
      const agreementId = new URL(url, "http://localhost").searchParams.get("agreementId") ?? "";
      return jsonResponse({ payments: payments[agreementId] ?? [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe("PaymentsList", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an empty state when there are no payments", async () => {
    vi.stubGlobal("fetch", buildFetchMock({}));
    render(<PaymentsList />);
    expect(await screen.findByText(/no payments yet/i)).toBeInTheDocument();
  });

  it("formats money via the shared formatter and maps status to plain language, never raw enum strings", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchMock({
        "agreement-1": [
          {
            id: "pay-1",
            status: "succeeded",
            amountMinorUnits: 150000,
            currency: "USD",
            agreementId: "agreement-1",
            payerProfileKind: "personal",
            payerProfileId: "profile-1",
            recipientProfileKind: "business",
            recipientProfileId: "profile-2",
            installmentScheduleItemId: null,
            paymentMethod: "ach",
            createdAt: new Date("2026-08-01").toISOString(),
          },
        ],
      }),
    );
    render(<PaymentsList />);
    expect(await screen.findByText("$1,500.00")).toBeInTheDocument();
    expect(screen.getByText("Cleared")).toBeInTheDocument();
    expect(screen.queryByText("succeeded")).not.toBeInTheDocument();
    expect(screen.getByText("You paid")).toBeInTheDocument();
  });

  describe("PAID2YOU — B0-D PHASE 3D (payout status accuracy)", () => {
    function paymentAsRecipient(overrides: Record<string, unknown> = {}) {
      return {
        id: "pay-1",
        status: "succeeded",
        amountMinorUnits: 150000,
        currency: "USD",
        agreementId: "agreement-1",
        payerProfileKind: "personal",
        payerProfileId: "someone-else",
        recipientProfileKind: "personal",
        recipientProfileId: "profile-1",
        installmentScheduleItemId: null,
        paymentMethod: "ach",
        createdAt: new Date("2026-08-01").toISOString(),
        payoutStatus: null,
        ...overrides,
      };
    }

    it("NEVER says 'You received' for the creditor — a cleared payment with no payout_attempt yet reads as still owed, not paid", async () => {
      vi.stubGlobal("fetch", buildFetchMock({ "agreement-1": [paymentAsRecipient({ payoutStatus: null })] }));
      render(<PaymentsList />);
      await screen.findByText("$1,500.00");
      expect(screen.queryByText("You received")).not.toBeInTheDocument();
      expect(screen.getByText("Owed — not yet paid")).toBeInTheDocument();
    });

    it("shows 'Owed — not yet paid' for a pending payout_attempt — never 'Paid'", async () => {
      vi.stubGlobal("fetch", buildFetchMock({ "agreement-1": [paymentAsRecipient({ payoutStatus: "pending" })] }));
      render(<PaymentsList />);
      expect(await screen.findByText("Owed — not yet paid")).toBeInTheDocument();
      expect(screen.queryByText(/^Paid/)).not.toBeInTheDocument();
    });

    it("shows 'Paid to you' ONLY when payout_attempt is genuinely confirmed", async () => {
      vi.stubGlobal("fetch", buildFetchMock({ "agreement-1": [paymentAsRecipient({ payoutStatus: "confirmed" })] }));
      render(<PaymentsList />);
      expect(await screen.findByText("Paid to you")).toBeInTheDocument();
    });

    it("shows 'Payout failed — still owed' for a failed payout — never implies payment", async () => {
      vi.stubGlobal("fetch", buildFetchMock({ "agreement-1": [paymentAsRecipient({ payoutStatus: "failed" })] }));
      render(<PaymentsList />);
      expect(await screen.findByText("Payout failed — still owed")).toBeInTheDocument();
      expect(screen.queryByText("Paid to you")).not.toBeInTheDocument();
    });

    it("shows 'Payout returned — still owed' for a returned payout — the creditor is not paid, the liability is restored", async () => {
      vi.stubGlobal("fetch", buildFetchMock({ "agreement-1": [paymentAsRecipient({ payoutStatus: "returned" })] }));
      render(<PaymentsList />);
      expect(await screen.findByText("Payout returned — still owed")).toBeInTheDocument();
      expect(screen.queryByText("Paid to you")).not.toBeInTheDocument();
    });

    it("a payment the viewer PAID (not owns as creditor) never shows payout-owed/paid language — only 'You paid'", async () => {
      vi.stubGlobal(
        "fetch",
        buildFetchMock({
          "agreement-1": [
            {
              id: "pay-payer-row",
              status: "succeeded",
              amountMinorUnits: 150000,
              currency: "USD",
              agreementId: "agreement-1",
              payerProfileKind: "personal",
              payerProfileId: "profile-1",
              recipientProfileKind: "business",
              recipientProfileId: "someone-elses-business",
              installmentScheduleItemId: null,
              paymentMethod: "ach",
              createdAt: new Date("2026-08-01").toISOString(),
              payoutStatus: "confirmed", // the CREDITOR's payout status — irrelevant to how the payer's own row reads.
            },
          ],
        }),
      );
      render(<PaymentsList />);
      expect(await screen.findByText("You paid")).toBeInTheDocument();
      expect(screen.queryByText("Paid to you")).not.toBeInTheDocument();
      expect(screen.queryByText("Owed — not yet paid")).not.toBeInTheDocument();
    });
  });

  it("shows a sign-in prompt when the session is unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ status: "error", code: "UNAUTHENTICATED", message: "Authentication required." }, false, 401)),
    );
    render(<PaymentsList />);
    expect(await screen.findByText(/sign in/i)).toBeInTheDocument();
  });
});
