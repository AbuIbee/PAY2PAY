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

  it("shows a sign-in prompt when the session is unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ status: "error", code: "UNAUTHENTICATED", message: "Authentication required." }, false, 401)),
    );
    render(<PaymentsList />);
    expect(await screen.findByText(/sign in/i)).toBeInTheDocument();
  });
});
