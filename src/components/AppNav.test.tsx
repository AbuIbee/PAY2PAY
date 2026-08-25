import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNav } from "./AppNav";

const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => "/dashboard",
}));

/**
 * PRSprint 10A (docs/prsprints/PRSPRINT_10A_AUTHENTICATION_SIGNOUT_UI_REMEDIATION.md): regression
 * coverage for the root cause this PRSprint fixed — the mobile topbar (`.app-topbar`) had CSS but
 * no component ever rendered it, so on any viewport narrower than the sidebar breakpoint the only
 * Sign Out control in the app (the sidebar's own "Log out" button) was completely unreachable.
 * jsdom does not evaluate CSS media queries, so these tests verify what actually matters at the
 * component level: the topbar's "Log out" control exists in the DOM unconditionally (never gated
 * behind opening the menu first) and is wired to the real logout endpoint + redirect.
 */
function stubNavFetches(
  activeProfile: { kind: "personal" | "business"; displayName: string } = { kind: "personal", displayName: "Personal" },
  liveCardIssuanceEnabled = false,
) {
  return vi.fn().mockImplementation(async (input: string) => {
    if (input === "/api/auth/me") return { ok: true, status: 200, json: async () => ({ email: "user@example.com" }) };
    if (input === "/api/admin/whoami") return { ok: true, status: 200, json: async () => ({ isAdmin: false }) };
    if (input === "/api/notifications") return { ok: true, status: 200, json: async () => ({ notifications: [] }) };
    if (input === "/api/auth/logout") return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    if (input === "/api/profiles/active") return { ok: true, status: 200, json: async () => activeProfile };
    if (input === "/api/feature-flags") return { ok: true, status: 200, json: async () => ({ liveCardIssuanceEnabled }) };
    throw new Error(`Unhandled fetch: ${input}`);
  });
}

describe("AppNav", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    refresh.mockClear();
  });

  it("always renders a topbar Log out control (present in the DOM unconditionally — jsdom doesn't evaluate the CSS media query that shows it only on narrow viewports), independent of the mobile menu drawer", async () => {
    vi.stubGlobal("fetch", stubNavFetches());
    render(<AppNav />);

    // Two controls exist by design (topbar fast-path + drawer footer, shown at different
    // viewport widths by CSS) — this asserts the topbar's is present at all, which is the whole
    // point of this PRSprint's fix (see app-shell.css's own doc comment on `.app-topbar`).
    const logoutButtons = await screen.findAllByRole("button", { name: /log out/i });
    expect(logoutButtons.length).toBeGreaterThanOrEqual(1);
    // Never gated behind the hamburger menu — the menu toggle defaults to closed.
    expect(screen.getByRole("button", { name: /^menu$/i })).toHaveAttribute("aria-expanded", "false");
  });

  it("clicking the topbar Log out control signs the user out and redirects to /login", async () => {
    const fetchMock = stubNavFetches();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AppNav />);

    const [topbarLogout] = await screen.findAllByRole("button", { name: /log out/i });
    await user.click(topbarLogout!);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    });
    expect(push).toHaveBeenCalledWith("/login");
    expect(refresh).toHaveBeenCalled();
  });

  it("PRSprint 27: shows a persistent 'Acting as <business>' indicator (both in the always-visible mobile topbar and the sidebar) when the active profile is a business, but not for the default personal profile", async () => {
    vi.stubGlobal("fetch", stubNavFetches({ kind: "business", displayName: "Acme LLC" }));
    render(<AppNav />);

    const indicators = await screen.findAllByText(/acting as acme llc/i);
    expect(indicators.length).toBeGreaterThanOrEqual(1);
  });

  it("PRSprint 27: shows no 'Acting as' indicator for the default personal profile", async () => {
    vi.stubGlobal("fetch", stubNavFetches({ kind: "personal", displayName: "Personal" }));
    render(<AppNav />);

    await screen.findByRole("button", { name: /^menu$/i });
    expect(screen.queryByText(/acting as/i)).not.toBeInTheDocument();
  });

  it("the menu toggle opens the full navigation drawer, which also contains a working Log out control", async () => {
    const fetchMock = stubNavFetches();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AppNav />);

    const menuButton = await screen.findByRole("button", { name: /^menu$/i });
    await user.click(menuButton);
    expect(menuButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^close$/i })).toBeInTheDocument();

    // Two "Log out" controls now exist (topbar fast-path + drawer footer) — both must work.
    const logoutButtons = screen.getAllByRole("button", { name: /log out/i });
    expect(logoutButtons.length).toBeGreaterThanOrEqual(2);
    await user.click(logoutButtons[1]!);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    });
    expect(push).toHaveBeenCalledWith("/login");
  });

  /**
   * Section H (closed-beta remediation): no live card-issuing provider is registered anywhere in
   * this codebase, and /cards permanently renders an unconditional "Not yet available" state — the
   * nav link must not offer it unless liveCardIssuanceEnabled is actually on.
   */
  it("hides the Cards nav link when liveCardIssuanceEnabled is off (the default)", async () => {
    vi.stubGlobal("fetch", stubNavFetches(undefined, false));
    render(<AppNav />);

    await screen.findByRole("button", { name: /^menu$/i });
    expect(screen.queryByRole("link", { name: /^cards$/i })).not.toBeInTheDocument();
  });

  it("shows the Cards nav link once liveCardIssuanceEnabled is on", async () => {
    vi.stubGlobal("fetch", stubNavFetches(undefined, true));
    render(<AppNav />);

    expect(await screen.findByRole("link", { name: /^cards$/i })).toBeInTheDocument();
  });

  /**
   * Demo navigation & dedicated demo experiences (Product Owner request): AppNav renders a single
   * DOM tree for both desktop and mobile (CSS toggles `.app-nav--mobile-open`, jsdom does not
   * evaluate that media query — same precedent this file's own doc comment already establishes for
   * the Log out coverage above), so "appears in authenticated desktop navigation" and "appears in
   * mobile navigation" are covered by the same underlying markup — the second test below opens the
   * mobile drawer explicitly to prove the Demo section isn't conditionally excluded from it.
   */
  it("shows a Demo section (heading + all 4 links) in the authenticated navigation, positioned after the primary links and before Account", async () => {
    vi.stubGlobal("fetch", stubNavFetches());
    render(<AppNav />);

    await screen.findByRole("button", { name: /^menu$/i });
    expect(screen.getByText("Demo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^p2p demo$/i })).toHaveAttribute("href", "/demo/p2p");
    expect(screen.getByRole("link", { name: /^c2b demo$/i })).toHaveAttribute("href", "/demo/c2b");
    expect(screen.getByRole("link", { name: /^b2b demo$/i })).toHaveAttribute("href", "/demo/b2b");
    expect(screen.getByRole("link", { name: /^product tour$/i })).toHaveAttribute("href", "/demo/tour");

    // Order: Demo section label comes after Support (last primary link) and before Account.
    const labels = screen.getAllByText(/^demo$|^support$|^account$/i).map((el) => el.textContent);
    const supportIndex = labels.indexOf("Support");
    const demoIndex = labels.indexOf("Demo");
    const accountIndex = labels.indexOf("Account");
    expect(supportIndex).toBeGreaterThanOrEqual(0);
    expect(demoIndex).toBeGreaterThan(supportIndex);
    expect(accountIndex).toBeGreaterThan(demoIndex);
  });

  it("the Demo section (heading + all 4 links) is also present inside the opened mobile navigation drawer", async () => {
    vi.stubGlobal("fetch", stubNavFetches());
    const user = userEvent.setup();
    render(<AppNav />);

    const menuButton = await screen.findByRole("button", { name: /^menu$/i });
    await user.click(menuButton);
    expect(menuButton).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByText("Demo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^p2p demo$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^c2b demo$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^b2b demo$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^product tour$/i })).toBeInTheDocument();
  });

  it("Demo nav links are static routes only — never carry the signed-in user's email, active profile, or any other private data", async () => {
    vi.stubGlobal("fetch", stubNavFetches({ kind: "business", displayName: "Acme LLC" }));
    render(<AppNav />);

    await screen.findAllByText(/acting as acme llc/i);
    for (const [label, href] of [
      ["P2P Demo", "/demo/p2p"],
      ["C2B Demo", "/demo/c2b"],
      ["B2B Demo", "/demo/b2b"],
      ["Product Tour", "/demo/tour"],
    ] as const) {
      const link = screen.getByRole("link", { name: new RegExp(`^${label}$`, "i") });
      expect(link).toHaveAttribute("href", href);
      expect(link.getAttribute("href")).not.toMatch(/user@example\.com|acme|email=|profile=/i);
    }
  });

  it("does not remove or replace any existing primary/account/organization navigation links when adding Demo", async () => {
    vi.stubGlobal("fetch", stubNavFetches());
    render(<AppNav />);

    await screen.findByRole("button", { name: /^menu$/i });
    for (const label of ["Dashboard", "Connections", "Agreements", "Payments", "Payment Methods", "Notifications", "Support"]) {
      expect(screen.getByRole("link", { name: new RegExp(`^${label}$`, "i") })).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: /^settings$/i })).toHaveAttribute("href", "/account");
    // Organization Features: Coming Soon treatment — "Staff" is intentionally no longer a working
    // link (StaffService.requireActiveStaff blocks a real business owner every time; see AppNav.tsx's
    // own doc comment) — it must still be visible, just non-interactive.
    expect(screen.queryByRole("link", { name: /^staff$/i })).not.toBeInTheDocument();
    expect(screen.getByText("Staff")).toBeInTheDocument();
  });

  describe("Organization Features: Coming Soon treatment", () => {
    it("3/4/5. every Organization link (Staff, Custom roles, Approvals) shows visible 'Coming Soon' text and is not a working/navigable link", async () => {
      vi.stubGlobal("fetch", stubNavFetches());
      render(<AppNav />);
      await screen.findByRole("button", { name: /^menu$/i });

      for (const label of ["Staff", "Custom roles", "Approvals"]) {
        expect(screen.queryByRole("link", { name: new RegExp(`^${label}$`, "i") })).not.toBeInTheDocument();
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      // "Coming Soon" is visible text, not merely a color/style difference — one per Organization item.
      expect(screen.getAllByText("Coming Soon")).toHaveLength(3);
    });

    it("3/4. the Coming Soon rows carry accessible disabled semantics (aria-disabled), not just visual styling", async () => {
      vi.stubGlobal("fetch", stubNavFetches());
      render(<AppNav />);
      await screen.findByRole("button", { name: /^menu$/i });

      const staffRow = screen.getByText("Staff").closest("[aria-disabled]");
      expect(staffRow).toHaveAttribute("aria-disabled", "true");
    });

    it("6. working navigation links (Dashboard, Connections, Settings, etc.) remain real, clickable links, unaffected by the Organization Coming Soon treatment", async () => {
      vi.stubGlobal("fetch", stubNavFetches());
      render(<AppNav />);
      await screen.findByRole("button", { name: /^menu$/i });

      expect(screen.getByRole("link", { name: /^dashboard$/i })).toHaveAttribute("href", "/dashboard");
      expect(screen.getByRole("link", { name: /^connections$/i })).toHaveAttribute("href", "/connections");
      expect(screen.getByRole("link", { name: /^settings$/i })).toHaveAttribute("href", "/account");
    });
  });
});
