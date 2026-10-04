import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationUnavailableResource } from "./OrganizationUnavailableResource";

describe("OrganizationUnavailableResource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the honest unavailable message once the server confirms the member can read this resource", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ allowed: true }) }));
    render(<OrganizationUnavailableResource organizationId="org-a" permissionKey="reconciliation.view" title="Reconciliation" message="Reconciliation tools are not available yet." />);
    expect(await screen.findByText("Reconciliation tools are not available yet.")).toBeInTheDocument();
  });

  it("shows a permission-denied message, never the feature message, when the server says the member cannot read this resource", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ allowed: false }) }));
    render(<OrganizationUnavailableResource organizationId="org-a" permissionKey="integrations.view" title="Integrations" message="No integrations are available yet." />);
    expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.queryByText("No integrations are available yet.")).not.toBeInTheDocument();
  });

  it("never infers access from the nav link being visible — it always calls the server's own resource-access check for the given resourceType", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ allowed: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<OrganizationUnavailableResource organizationId="org-a" permissionKey="audit.view" title="Audit History" message="Audit history viewing is not available yet." />);
    await screen.findByText("Audit history viewing is not available yet.");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("permission=audit.view"), expect.anything());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("organizationId=org-a"), expect.anything());
  });
});
