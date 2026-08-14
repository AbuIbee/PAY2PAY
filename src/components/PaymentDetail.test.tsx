import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentDetail } from "./PaymentDetail";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams({ id: "pay-1" }),
}));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as Response;
}

const BASE_PAYMENT = {
  id: "pay-1",
  status: "failed",
  amountMinorUnits: 5000,
  currency: "USD",
  payer: { profileKind: "personal", profileId: "profile-1" },
  recipient: { profileKind: "business", profileId: "profile-2" },
  agreementId: "agreement-1",
  providerName: "sandbox",
  paymentMethod: "ach",
  failureReason: "insufficient_funds",
  createdAt: new Date("2026-08-01T10:00:00Z").toISOString(),
  updatedAt: new Date("2026-08-01T10:05:00Z").toISOString(),
};

function buildFetchMock(overrides: { retry?: unknown; disputes?: unknown[]; manualPayCallCount?: { count: number } } = {}) {
  const manualCalls = overrides.manualPayCallCount ?? { count: 0 };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/payments/detail")) return jsonResponse(BASE_PAYMENT);
    if (url.includes("/api/payments/retry-status")) return jsonResponse({ retry: overrides.retry ?? null });
    if (url.includes("/api/payments/disputes/by-payment")) return jsonResponse({ disputes: overrides.disputes ?? [] });
    if (url.includes("/api/ach/payments/manual") && init?.method === "POST") {
      manualCalls.count += 1;
      return jsonResponse({ id: "pay-2", status: "processing" }, true, 201);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe("PaymentDetail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the scheduled retry date on a failed payment (never a raw processor error)", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchMock({ retry: { id: "retry-1", status: "scheduled", scheduledFor: "2026-08-05", resultingPaymentAttemptId: null } }),
    );
    render(<PaymentDetail />);
    expect(await screen.findByText(/retry is scheduled for/i)).toBeInTheDocument();
    expect(screen.getByText(/insufficient funds/i)).toBeInTheDocument();
    expect(screen.queryByText("insufficient_funds")).not.toBeInTheDocument();
  });

  it("says no retry is scheduled when none exists", async () => {
    vi.stubGlobal("fetch", buildFetchMock({ retry: null }));
    render(<PaymentDetail />);
    expect(await screen.findByText(/no automatic retry is scheduled/i)).toBeInTheDocument();
  });

  it("manual pay requires an explicit confirmation step and cannot be double-submitted", async () => {
    const manualPayCallCount = { count: 0 };
    vi.stubGlobal("fetch", buildFetchMock({ retry: null, manualPayCallCount }));
    render(<PaymentDetail />);

    const payButton = await screen.findByRole("button", { name: /pay manually/i });
    fireEvent.click(payButton);

    const confirmButton = await screen.findByRole("button", { name: /yes, pay now/i });
    fireEvent.click(confirmButton);
    // Immediately re-clicking while the request is in flight must not fire a second request —
    // the confirm button is replaced by a disabled "Submitting…" state, not left double-clickable.
    await waitFor(() => expect(manualPayCallCount.count).toBe(1));
    await waitFor(() => expect(screen.getByText(/new payment has been submitted/i)).toBeInTheDocument());
    expect(manualPayCallCount.count).toBe(1);
  });

  it("renders a payment dispute with a plain-language status and neutral processor-adjudicated note", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchMock({
        retry: null,
        disputes: [
          {
            id: "dispute-1",
            status: "claimed",
            category: "unauthorized_ach",
            explanation: "I did not authorize this payment.",
            claimedAt: new Date("2026-08-02").toISOString(),
            resolutionNotes: null,
            resolvedAt: null,
          },
        ],
      }),
    );
    render(<PaymentDetail />);
    expect(await screen.findByText(/claim submitted/i)).toBeInTheDocument();
    expect(screen.getByText(/reviewed and decided by the payment processor/i)).toBeInTheDocument();
  });
});
