import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationApprovals } from "./OrganizationApprovals";

describe("OrganizationApprovals", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables Approve/Reject for a request the current user proposed themselves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string) => {
        if (input === "/api/profiles/active") return { ok: true, status: 200, json: async () => ({ kind: "business", businessProfileId: "biz-1" }) };
        if (input === "/api/auth/me") return { ok: true, status: 200, json: async () => ({ id: "owner-1" }) };
        if (input.startsWith("/api/staff?")) return { ok: true, status: 200, json: async () => ({ staff: [{ id: "staff-1", userId: "owner-1" }] }) };
        if (input.startsWith("/api/staff/approval-requests?")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              requests: [
                { id: "req-1", proposedByStaffId: "staff-1", relatedAgreementId: null, actionType: "approve_settlement", reasonFlagged: "Over threshold", status: "pending", createdAt: new Date().toISOString() },
              ],
            }),
          };
        }
        throw new Error(`Unhandled fetch: ${input}`);
      }),
    );

    render(<OrganizationApprovals />);
    expect(await screen.findByText(/you proposed this/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /reject/i })).toBeDisabled();
  });

  it("enables and submits a decision for a request proposed by someone else", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/profiles/active") return { ok: true, status: 200, json: async () => ({ kind: "business", businessProfileId: "biz-1" }) };
      if (input === "/api/auth/me") return { ok: true, status: 200, json: async () => ({ id: "owner-1" }) };
      if (input.startsWith("/api/staff?")) return { ok: true, status: 200, json: async () => ({ staff: [{ id: "staff-owner", userId: "owner-1" }] }) };
      if (input.startsWith("/api/staff/approval-requests?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            requests: [
              { id: "req-2", proposedByStaffId: "staff-manager", relatedAgreementId: null, actionType: "forgive_principal", reasonFlagged: "Large forgiveness", status: "pending", createdAt: new Date().toISOString() },
            ],
          }),
        };
      }
      if (input === "/api/staff/approval-requests/decide" && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ id: "req-2", status: "approved" }) };
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<OrganizationApprovals />);
    const approveButton = await screen.findByRole("button", { name: /approve/i });
    expect(approveButton).toBeEnabled();
    await user.click(approveButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/staff/approval-requests/decide",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ businessProfileId: "biz-1", requestId: "req-2", decision: "approved" }) }),
      );
    });
  });
});
