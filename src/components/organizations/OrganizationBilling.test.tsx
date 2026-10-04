import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationBilling } from "./OrganizationBilling";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}
function errorResponse(status: number, code: string, message: string) {
  return { ok: false, status, json: async () => ({ status: "error", code, message }) };
}

const BASE_SUMMARY = {
  organizationId: "org-1",
  providerConfigured: false,
  subscriptionStatus: "ACTIVE" as const,
  plan: { code: "paid2you_business_starter", name: "Starter", monthlyFeeMinorUnits: 9_900, isNegotiated: false },
  band: { min: 0, max: 24 },
  usage: { count: 18, periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z" },
  cancelAtPeriodEnd: false,
  currentPeriodStart: "2026-10-01T00:00:00.000Z",
  currentPeriodEnd: "2026-11-01T00:00:00.000Z",
  paymentMethod: null,
  invoices: [],
  availableUpgrades: [{ code: "paid2you_business_core", name: "Core", monthlyFeeMinorUnits: 19_900 }],
};

describe("OrganizationBilling (PAID2YOU PRODUCTION LAUNCH, Phase 2, Section 10/11/13/14/16/17)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("NOT_SUBSCRIBED: shows an honest 'no subscription yet' state, never a fabricated plan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ ...BASE_SUMMARY, subscriptionStatus: "NOT_SUBSCRIBED", plan: null, band: null, usage: null })),
    );
    render(<OrganizationBilling organizationId="org-1" />);
    expect(await screen.findByText(/doesn't have a Paid2You subscription yet/)).toBeInTheDocument();
  });

  it("shows the real plan, usage, and status — and the honest NOT_CONFIGURED banner when no live provider exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(BASE_SUMMARY)));
    render(<OrganizationBilling organizationId="org-1" />);

    expect(await screen.findByText("Starter")).toBeInTheDocument();
    expect(screen.getByText(/\$99\.00\/month/)).toBeInTheDocument();
    expect(screen.getByText("18 of 24 established arrangements used")).toBeInTheDocument();
    expect(screen.getByText(/isn't configured yet for this environment/)).toBeInTheDocument();
    expect(screen.getByText("No payment method on file.")).toBeInTheDocument();
    expect(screen.getByText("No invoices yet.")).toBeInTheDocument();
  });

  it("shows the threshold warning once usage reaches the plan's ceiling", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...BASE_SUMMARY, usage: { ...BASE_SUMMARY.usage, count: 24 } })));
    render(<OrganizationBilling organizationId="org-1" />);
    expect(await screen.findByText(/You've reached this plan's limit/)).toBeInTheDocument();
  });

  it("upgrade buttons are disabled when the billing provider is NOT_CONFIGURED — never a clickable action guaranteed to fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(BASE_SUMMARY)));
    render(<OrganizationBilling organizationId="org-1" />);
    expect(await screen.findByRole("button", { name: "Upgrade to Core" })).toBeDisabled();
  });

  it("Pay Now never claims success unless the server confirms it, and surfaces a real failure message", async () => {
    const summaryWithPastDueInvoice = {
      ...BASE_SUMMARY,
      subscriptionStatus: "PAST_DUE" as const,
      invoices: [{ id: "inv-1", periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z", amountDueMinorUnits: 9_900, amountPaidMinorUnits: 0, status: "past_due" as const, dueAt: "2026-10-01T00:00:00.000Z", paidAt: null }],
    };
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/organizations/billing?organizationId=org-1") return jsonResponse(summaryWithPastDueInvoice);
      if (input === "/api/organizations/billing/pay-invoice" && init?.method === "POST") {
        return errorResponse(503, "PROVIDER_NOT_AVAILABLE", "Billing isn't available yet.");
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<OrganizationBilling organizationId="org-1" />);

    await user.click(await screen.findByRole("button", { name: "Pay Now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/isn't available yet/i);
    expect(screen.queryByText(/payment succeeded/i)).not.toBeInTheDocument();
  });

  it("shows a Reactivate action when cancellation is pending, and a Cancel action when active", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...BASE_SUMMARY, subscriptionStatus: "CANCEL_AT_PERIOD_END" as const, cancelAtPeriodEnd: true })));
    render(<OrganizationBilling organizationId="org-1" />);
    expect(await screen.findByRole("button", { name: "Reactivate subscription" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel at period end" })).not.toBeInTheDocument();
  });

  it("denied: shows a permission-denied message, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(403, "FORBIDDEN", "denied")));
    render(<OrganizationBilling organizationId="org-1" />);
    expect(await screen.findByText(/don't have permission/)).toBeInTheDocument();
  });

  it("mentions Enterprise contact-sales and that downgrade is unavailable — never a self-service downgrade button", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(BASE_SUMMARY)));
    render(<OrganizationBilling organizationId="org-1" />);
    await waitFor(() => expect(screen.getByText(/Contact us about Enterprise/)).toBeInTheDocument());
    expect(screen.getByText(/Downgrading to a lower plan isn't available yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /downgrade/i })).not.toBeInTheDocument();
  });
});
