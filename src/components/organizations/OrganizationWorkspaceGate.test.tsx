import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationWorkspaceGate } from "./OrganizationWorkspaceGate";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Step 5/12: the organization route shell's client-side
 * presence check. The real fail-closed boundary is `WorkspaceContextService.resolveWorkspaceContext`
 * (exercised directly by workspaceContext.test.ts and the /api/workspace/active route tests) — these
 * tests only verify this component reacts correctly to that endpoint's possible responses.
 */
describe("OrganizationWorkspaceGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    replace.mockClear();
  });

  it("renders children once the server confirms active membership in this exact organization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ kind: "organization", organizationId: "org-a" }) }),
    );
    render(
      <OrganizationWorkspaceGate organizationId="org-a">
        <p>Protected content</p>
      </OrganizationWorkspaceGate>,
    );
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects to My Paid2You when the server falls back to personal (removed/invalid membership) rather than rendering the children", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ kind: "personal" }) }));
    render(
      <OrganizationWorkspaceGate organizationId="org-a">
        <p>Protected content</p>
      </OrganizationWorkspaceGate>,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("redirects when the server resolves a DIFFERENT organization than the one in the URL (e.g. a stale cookie)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ kind: "organization", organizationId: "org-b" }) }),
    );
    render(
      <OrganizationWorkspaceGate organizationId="org-a">
        <p>Protected content</p>
      </OrganizationWorkspaceGate>,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("redirects on a failed/unauthenticated request rather than rendering anything protected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ status: "error", code: "UNAUTHENTICATED", message: "nope" }) }));
    render(
      <OrganizationWorkspaceGate organizationId="org-a">
        <p>Protected content</p>
      </OrganizationWorkspaceGate>,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });
});
