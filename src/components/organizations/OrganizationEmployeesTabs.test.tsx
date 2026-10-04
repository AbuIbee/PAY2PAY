import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationEmployeesTabs } from "./OrganizationEmployeesTabs";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}

describe("OrganizationEmployeesTabs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetches() {
    return vi.fn().mockImplementation(async (input: string) => {
      if (input.startsWith("/api/organizations/employees")) {
        return jsonResponse({ items: [{ id: "m1", userId: "u1", email: "owner@example.com", roleId: "r1", roleName: "Owner", isOwnerRole: true, isAuthorizedRepresentative: true, memberSince: "2026-01-01" }] });
      }
      if (input.startsWith("/api/organizations/roles")) {
        return jsonResponse({ catalog: [], roles: [{ id: "r1", displayName: "Owner", description: null, isOwnerRole: true, isProtected: true, memberCount: 1, permissions: [] }] });
      }
      if (input.startsWith("/api/organizations/invitations")) {
        return jsonResponse({ items: [] });
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
  }

  it("defaults to the Team Members tab", async () => {
    vi.stubGlobal("fetch", stubFetches());
    render(<OrganizationEmployeesTabs organizationId="org-a" />);
    expect(await screen.findByText("owner@example.com")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Team Members" })).toHaveAttribute("aria-selected", "true");
  });

  it("switching to Invitations shows that tab's own content, independently loaded", async () => {
    vi.stubGlobal("fetch", stubFetches());
    const user = userEvent.setup();
    render(<OrganizationEmployeesTabs organizationId="org-a" />);
    await screen.findByText("owner@example.com");

    await user.click(screen.getByRole("tab", { name: "Invitations" }));
    expect(await screen.findByText("No pending invitations.")).toBeInTheDocument();
  });

  it("switching to Roles & Permissions shows the server's own roles list", async () => {
    vi.stubGlobal("fetch", stubFetches());
    const user = userEvent.setup();
    render(<OrganizationEmployeesTabs organizationId="org-a" />);
    await screen.findByText("owner@example.com");

    await user.click(screen.getByRole("tab", { name: "Roles & Permissions" }));
    await waitFor(() => expect(screen.getByDisplayValue("Owner")).toBeInTheDocument());
    expect(screen.getByText("Owner (protected)")).toBeInTheDocument();
  });

  it("a tab the caller lacks permission for shows a denied message, not the other tabs' data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string) => {
        if (input.startsWith("/api/organizations/employees")) return jsonResponse({ items: [] });
        if (input.startsWith("/api/organizations/roles")) {
          return { ok: false, status: 403, json: async () => ({ status: "error", code: "FORBIDDEN", message: "denied" }) };
        }
        throw new Error(`Unhandled fetch: ${input}`);
      }),
    );
    const user = userEvent.setup();
    render(<OrganizationEmployeesTabs organizationId="org-a" />);
    await screen.findByText("No team members yet.");

    await user.click(screen.getByRole("tab", { name: "Roles & Permissions" }));
    expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();
  });
});
