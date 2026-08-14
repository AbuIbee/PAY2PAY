import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationStaff } from "./OrganizationStaff";

function stubFetch(handlers: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: string) => {
      const key = Object.keys(handlers).find((k) => input.startsWith(k));
      if (!key) throw new Error(`Unhandled fetch: ${input}`);
      return { ok: true, status: 200, json: async () => handlers[key] };
    }),
  );
}

describe("OrganizationStaff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a guard state when no business profile is active", async () => {
    stubFetch({
      "/api/profiles/active": { kind: "personal" },
      "/api/auth/me": { id: "user-1" },
    });
    render(<OrganizationStaff />);
    expect(await screen.findByText(/no business selected/i)).toBeInTheDocument();
  });

  it("hides the Invite staff action for a viewer role without manage_staff", async () => {
    stubFetch({
      "/api/profiles/active": { kind: "business", businessProfileId: "biz-1" },
      "/api/auth/me": { id: "viewer-1" },
      "/api/staff?businessProfileId=biz-1": {
        staff: [
          { id: "member-1", userId: "viewer-1", role: "accountant_viewer", customRoleId: null, isAuthorizedRepresentative: false, createdAt: new Date().toISOString() },
        ],
      },
      "/api/staff/custom-roles?businessProfileId=biz-1": { customRoles: [] },
    });
    render(<OrganizationStaff />);
    await waitFor(() => expect(screen.getByText(/team members/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /invite staff/i })).not.toBeInTheDocument();
  });

  it("shows the Invite staff action for an owner", async () => {
    stubFetch({
      "/api/profiles/active": { kind: "business", businessProfileId: "biz-1" },
      "/api/auth/me": { id: "owner-1" },
      "/api/staff?businessProfileId=biz-1": {
        staff: [
          { id: "member-1", userId: "owner-1", role: "owner", customRoleId: null, isAuthorizedRepresentative: true, createdAt: new Date().toISOString() },
        ],
      },
      "/api/staff/custom-roles?businessProfileId=biz-1": { customRoles: [] },
    });
    render(<OrganizationStaff />);
    expect(await screen.findByRole("button", { name: /invite staff/i })).toBeInTheDocument();
  });
});
