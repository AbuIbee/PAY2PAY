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
function stubNavFetches() {
  return vi.fn().mockImplementation(async (input: string) => {
    if (input === "/api/auth/me") return { ok: true, status: 200, json: async () => ({ email: "user@example.com" }) };
    if (input === "/api/admin/whoami") return { ok: true, status: 200, json: async () => ({ isAdmin: false }) };
    if (input === "/api/notifications") return { ok: true, status: 200, json: async () => ({ notifications: [] }) };
    if (input === "/api/auth/logout") return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
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
});
