import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationStaffRoles } from "./OrganizationStaffRoles";

describe("OrganizationStaffRoles", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("translates raw capability keys into plain-language labels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string) => {
        if (input === "/api/profiles/active") return { ok: true, status: 200, json: async () => ({ kind: "business", businessProfileId: "biz-1" }) };
        if (input.startsWith("/api/staff/custom-roles?")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ customRoles: [{ id: "role-1", name: "Bookkeeper", permissions: ["approve_settlement", "export_records"] }] }),
          };
        }
        throw new Error(`Unhandled fetch: ${input}`);
      }),
    );

    render(<OrganizationStaffRoles />);
    expect(await screen.findByText("Bookkeeper")).toBeInTheDocument();
    expect(screen.getByText("Approve settlements")).toBeInTheDocument();
    expect(screen.getByText("Export records")).toBeInTheDocument();
    expect(screen.queryByText("approve_settlement")).not.toBeInTheDocument();
  });

  it("shows a step-up challenge on create, and retries the create after a successful verify", async () => {
    let roleCreated = false;
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/profiles/active") return { ok: true, status: 200, json: async () => ({ kind: "business", businessProfileId: "biz-1" }) };
      if (input.startsWith("/api/staff/custom-roles?")) return { ok: true, status: 200, json: async () => ({ customRoles: [] }) };
      if (input === "/api/staff/custom-roles" && init?.method === "POST") {
        if (!roleCreated) {
          return {
            ok: false,
            status: 403,
            json: async () => ({ status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required to create a custom role." }),
          };
        }
        return { ok: true, status: 201, json: async () => ({ id: "role-2", name: "Auditor", permissions: ["view_reports"] }) };
      }
      if (input === "/api/auth/mfa/status") return { ok: true, status: 200, json: async () => ({ enrolled: true, methods: ["totp"] }) };
      if (input === "/api/auth/mfa/step-up/initiate") return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      if (input === "/api/auth/mfa/step-up/verify") {
        roleCreated = true;
        return { ok: true, status: 200, json: async () => ({ passed: true }) };
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<OrganizationStaffRoles />);
    await user.click(await screen.findByRole("button", { name: /create custom role/i }));
    await user.type(screen.getByLabelText(/role name/i), "Auditor");
    await user.click(screen.getByRole("checkbox", { name: /view reports/i }));
    await user.click(screen.getByRole("button", { name: /^create role$/i }));

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    const codeInput = await screen.findByLabelText(/code from your authenticator app/i);
    await user.type(codeInput, "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/staff/custom-roles",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ businessProfileId: "biz-1", name: "Auditor", permissions: ["view_reports"] }) }),
      );
    });
    // Called twice: once that failed with STEP_UP_REQUIRED, once retried after verification succeeded.
    const createCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/staff/custom-roles");
    expect(createCalls).toHaveLength(2);
  });
});
