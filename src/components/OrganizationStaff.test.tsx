import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
          { id: "member-1", userId: "viewer-1", name: "Val Viewer", email: "viewer@example.com", role: "accountant_viewer", customRoleId: null, isAuthorizedRepresentative: false, createdAt: new Date().toISOString() },
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
          { id: "member-1", userId: "owner-1", name: "Jane Owner", email: "owner@example.com", role: "owner", customRoleId: null, isAuthorizedRepresentative: true, createdAt: new Date().toISOString() },
        ],
      },
      "/api/staff/custom-roles?businessProfileId=biz-1": { customRoles: [] },
    });
    render(<OrganizationStaff />);
    expect(await screen.findByRole("button", { name: /invite staff/i })).toBeInTheDocument();
  });

  it("PRSprint 08: an owner sees Change role/Remove for another member, but not for their own row, and a viewer sees neither", async () => {
    stubFetch({
      "/api/profiles/active": { kind: "business", businessProfileId: "biz-1" },
      "/api/auth/me": { id: "owner-1" },
      "/api/staff?businessProfileId=biz-1": {
        staff: [
          { id: "member-1", userId: "owner-1", name: "Jane Owner", email: "owner@example.com", role: "owner", customRoleId: null, isAuthorizedRepresentative: true, createdAt: new Date().toISOString() },
          { id: "member-2", userId: "staffer-1", name: "Sam Staffer", email: "staffer@example.com", role: "manager", customRoleId: null, isAuthorizedRepresentative: false, createdAt: new Date().toISOString() },
        ],
      },
      "/api/staff/custom-roles?businessProfileId=biz-1": { customRoles: [] },
    });
    render(<OrganizationStaff />);
    await waitFor(() => expect(screen.getByText(/team members/i)).toBeInTheDocument());

    // Owner's own row: no action buttons, just a "You" marker.
    const ownRow = screen.getByText("Jane Owner").closest("tr")!;
    expect(ownRow).toHaveTextContent(/you/i);
    expect(within(ownRow).queryByRole("button", { name: /change role/i })).not.toBeInTheDocument();
    expect(within(ownRow).queryByRole("button", { name: /^remove$/i })).not.toBeInTheDocument();

    // The other member's row: both actions present.
    const otherRow = screen.getByText("Sam Staffer").closest("tr")!;
    expect(within(otherRow).getByRole("button", { name: /change role/i })).toBeInTheDocument();
    expect(within(otherRow).getByRole("button", { name: /^remove$/i })).toBeInTheDocument();
  });

  it("PRSprint 08: a viewer without manage_staff sees no Actions column at all", async () => {
    stubFetch({
      "/api/profiles/active": { kind: "business", businessProfileId: "biz-1" },
      "/api/auth/me": { id: "viewer-1" },
      "/api/staff?businessProfileId=biz-1": {
        staff: [
          { id: "member-1", userId: "viewer-1", name: "Val Viewer", email: "viewer@example.com", role: "accountant_viewer", customRoleId: null, isAuthorizedRepresentative: false, createdAt: new Date().toISOString() },
          { id: "member-2", userId: "staffer-1", name: "Sam Staffer", email: "staffer@example.com", role: "manager", customRoleId: null, isAuthorizedRepresentative: false, createdAt: new Date().toISOString() },
        ],
      },
      "/api/staff/custom-roles?businessProfileId=biz-1": { customRoles: [] },
    });
    render(<OrganizationStaff />);
    await waitFor(() => expect(screen.getByText(/team members/i)).toBeInTheDocument());
    expect(screen.queryByRole("columnheader", { name: /actions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /change role/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^remove$/i })).not.toBeInTheDocument();
  });

  it("PRSprint 08: declining the confirm dialog does not remove the staff member", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      const handlers: Record<string, unknown> = {
        "/api/profiles/active": { kind: "business", businessProfileId: "biz-1" },
        "/api/auth/me": { id: "owner-1" },
        "/api/staff?businessProfileId=biz-1": {
          staff: [
            { id: "member-1", userId: "owner-1", name: "Jane Owner", email: "owner@example.com", role: "owner", customRoleId: null, isAuthorizedRepresentative: true, createdAt: new Date().toISOString() },
            { id: "member-2", userId: "staffer-1", name: "Sam Staffer", email: "staffer@example.com", role: "manager", customRoleId: null, isAuthorizedRepresentative: false, createdAt: new Date().toISOString() },
          ],
        },
        "/api/staff/custom-roles?businessProfileId=biz-1": { customRoles: [] },
      };
      const key = Object.keys(handlers).find((k) => input.startsWith(k));
      if (!key) throw new Error(`Unhandled fetch: ${input}`);
      return { ok: true, status: 200, json: async () => handlers[key] };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();

    render(<OrganizationStaff />);
    const otherRow = (await screen.findByText("Sam Staffer")).closest("tr")!;
    await user.click(within(otherRow).getByRole("button", { name: /^remove$/i }));

    expect(window.confirm).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/staff/remove")).toBe(false);
  });

  it("PRSprint 08: removing a staff member confirms, requires step-up, and retries after verification", async () => {
    let removed = false;
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "/api/profiles/active") return { ok: true, status: 200, json: async () => ({ kind: "business", businessProfileId: "biz-1" }) };
      if (input === "/api/auth/me") return { ok: true, status: 200, json: async () => ({ id: "owner-1" }) };
      if (input === "/api/staff?businessProfileId=biz-1") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            staff: removed
              ? [{ id: "member-1", userId: "owner-1", name: "Jane Owner", email: "owner@example.com", role: "owner", customRoleId: null, isAuthorizedRepresentative: true, createdAt: new Date().toISOString() }]
              : [
                  { id: "member-1", userId: "owner-1", name: "Jane Owner", email: "owner@example.com", role: "owner", customRoleId: null, isAuthorizedRepresentative: true, createdAt: new Date().toISOString() },
                  { id: "member-2", userId: "staffer-1", name: "Sam Staffer", email: "staffer@example.com", role: "manager", customRoleId: null, isAuthorizedRepresentative: false, createdAt: new Date().toISOString() },
                ],
          }),
        };
      }
      if (input.startsWith("/api/staff/custom-roles?")) return { ok: true, status: 200, json: async () => ({ customRoles: [] }) };
      if (input === "/api/staff/remove" && init?.method === "POST") {
        if (!removed) {
          return {
            ok: false,
            status: 403,
            json: async () => ({ status: "error", code: "STEP_UP_REQUIRED", message: "Step-up verification is required to remove this staff member." }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ status: "removed" }) };
      }
      if (input === "/api/auth/mfa/status") return { ok: true, status: 200, json: async () => ({ enrolled: true, methods: ["totp"] }) };
      if (input === "/api/auth/mfa/step-up/initiate") return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      if (input === "/api/auth/mfa/step-up/verify") {
        removed = true;
        return { ok: true, status: 200, json: async () => ({ passed: true }) };
      }
      throw new Error(`Unhandled fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<OrganizationStaff />);
    const otherRow = (await screen.findByText("Sam Staffer")).closest("tr")!;
    await user.click(within(otherRow).getByRole("button", { name: /^remove$/i }));

    expect(await screen.findByText(/verify it's you/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/code from your authenticator app/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() => {
      const removeCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/staff/remove");
      expect(removeCalls).toHaveLength(2);
    });
    // Confirms the row list was refreshed after a successful removal.
    await waitFor(() => expect(screen.queryByText("Sam Staffer")).not.toBeInTheDocument());
  });
});
