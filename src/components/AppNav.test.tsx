import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNav } from "./AppNav";

const push = vi.fn();
const refresh = vi.fn();
const mockUsePathname = vi.fn(() => "/dashboard");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => mockUsePathname(),
}));

function stubNavFetches(
  activeProfile: { kind: "personal" | "business"; displayName: string } = {
    kind: "personal",
    displayName: "Personal",
  },
  organizations: Array<{ organizationId: string; displayName: string }> = [],
) {
  return vi.fn().mockImplementation(async (input: string) => {
    if (input === "/api/auth/me") {
      return { ok: true, status: 200, json: async () => ({ email: "user@example.com" }) };
    }
    if (input === "/api/admin/whoami") {
      return { ok: true, status: 200, json: async () => ({ isAdmin: false }) };
    }
    if (input === "/api/profiles/active") {
      return { ok: true, status: 200, json: async () => activeProfile };
    }
    if (input === "/api/organizations") {
      return { ok: true, status: 200, json: async () => ({ organizations }) };
    }
    if (input === "/api/auth/logout") {
      return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    }
    throw new Error(`Unhandled fetch: ${input}`);
  });
}

function getGatewayRegion() {
  const businessLabel = screen.getByText("Paid2You", {
    selector: ".app-nav__gateway-copy strong",
  });
  const region = businessLabel.closest(".app-nav__gateways");
  if (!region) {
    throw new Error("Paid2You account gateway container was not rendered.");
  }
  return region as HTMLElement;
}

describe("AppNav", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    refresh.mockClear();
    mockUsePathname.mockReturnValue("/dashboard");
  });

  it("always renders the mobile fast-path Log out control", async () => {
    vi.stubGlobal("fetch", stubNavFetches());
    render(<AppNav />);

    const logoutButtons = await screen.findAllByRole("button", { name: /log out/i });
    expect(logoutButtons.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /^menu$/i })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows Business and Personal gateways on a Personal page", async () => {
    vi.stubGlobal("fetch", stubNavFetches());
    render(<AppNav />);

    await screen.findByText("Paid2You", { selector: ".app-nav__gateway-copy strong" });
    expect(screen.getByText("My Paid2You", { selector: ".app-nav__gateway-copy strong" })).toBeInTheDocument();

    const gateways = within(getGatewayRegion());
    expect(gateways.getByText("Current")).toBeInTheDocument();
    expect(gateways.getByRole("link", { name: /^sign in$/i })).toHaveAttribute(
      "href",
      "/login?accountType=business&next=%2Forganizations%2Fnew",
    );
    expect(gateways.getByRole("link", { name: /^create$/i })).toHaveAttribute(
      "href",
      "/organizations/new",
    );
  });

  it("renders the Personal launch navigation when Personal is current", async () => {
    vi.stubGlobal("fetch", stubNavFetches());
    render(<AppNav />);

    await screen.findByText("My Paid2You", { selector: ".app-nav__gateway-copy strong" });

    for (const label of ["Dashboard", "Agreements", "Payments", "Connections"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("renders the approved Business launch navigation inside an organization", async () => {
    mockUsePathname.mockReturnValue("/organizations/org-a/customers");
    vi.stubGlobal(
      "fetch",
      stubNavFetches(
        { kind: "business", displayName: "Business" },
        [{ organizationId: "org-a", displayName: "ABC Trucking LLC" }],
      ),
    );
    render(<AppNav />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });

    for (const label of [
      "Dashboard",
      "Outstanding Balances",
      "Customers",
      "Agreements",
      "Employees",
      "Organization Settings",
      "Billing & Subscription",
    ]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }

    for (const hidden of ["Reports", "Reconciliation", "Audit History", "Integrations"]) {
      expect(within(nav).queryByRole("link", { name: hidden })).not.toBeInTheDocument();
    }
  });

  it("sends the inactive Business gateway to a separate Business sign-in flow", async () => {
    vi.stubGlobal("fetch", stubNavFetches());
    render(<AppNav />);

    await screen.findByText("Paid2You", { selector: ".app-nav__gateway-copy strong" });
    const businessSignIn = within(getGatewayRegion()).getByRole("link", { name: /^sign in$/i });

    expect(businessSignIn).toHaveAttribute(
      "href",
      "/login?accountType=business&next=%2Forganizations%2Fnew",
    );
    expect(businessSignIn.getAttribute("href")).not.toBe("/organizations/new");
  });

  it("keeps Log out working", async () => {
    const fetchMock = stubNavFetches();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AppNav />);

    const [logout] = await screen.findAllByRole("button", { name: /log out/i });
    await user.click(logout!);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    });
    expect(push).toHaveBeenCalledWith("/login");
  });
});