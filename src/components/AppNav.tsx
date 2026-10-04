"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface NavLinkItem {
  href: string;
  label: string;
  /** Organization Features: Coming Soon treatment — renders as a non-interactive, clearly-labeled row instead of a working link. */
  comingSoon?: boolean;
}

/**
 * Sprint 18B core UX architecture: "Create one coherent authenticated
 * product shell... use separate role-aware admin navigation." Links here
 * are added only as their pages ship elsewhere in this sprint — never a
 * link to a route that doesn't exist yet ("no dead buttons/links").
 */
// Section H (closed-beta remediation): "Cards" is filtered out below unless liveCardIssuanceEnabled
// is on — no live card-issuing provider is registered anywhere in this codebase yet, and the page it
// links to (CardsManager) is permanently an unconditional "Not yet available" state until one is.
const PRIMARY_LINKS: NavLinkItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/notifications", label: "Notifications" },
  { href: "/agreements", label: "My Agreements" },
  { href: "/payments", label: "My Cash" },
  { href: "/payment-methods", label: "Bank Info" },
  { href: "/connections", label: "Connections" },
  { href: "/support", label: "Support" },
  { href: "/cards", label: "Cards" },
];

/**
 * Demo navigation & dedicated demo experiences (Product Owner request): discoverable from inside
 * the authenticated app, not just the public marketing site. These link to the same public,
 * fixture-data-only routes under (marketing)/demo — navigating here takes an authenticated user out
 * of the app shell into the public demo pages, which is intentional (same safe demo experience for
 * everyone, never a separate authenticated-only copy).
 */
const DEMO_LINKS: NavLinkItem[] = [
  { href: "/demo/p2p", label: "P2P Demo" },
  { href: "/demo/c2b", label: "C2B Demo" },
  { href: "/demo/b2b", label: "B2B Demo" },
  { href: "/demo/tour", label: "Product Tour" },
];

const ACCOUNT_LINKS: NavLinkItem[] = [
  { href: "/account", label: "Settings" },
  { href: "/account/security", label: "Security" },
  { href: "/account/verification", label: "Verification" },
];

// Organization Features: Coming Soon treatment — each of these depends on StaffService.
// requireActiveStaff, which a real business owner cannot currently pass (no business_staff_member
// row is ever seeded for them — see the dashboard-consistency-fix completion report for the root
// cause). Rendered below as non-interactive "Coming Soon" rows rather than working links into a page
// that would just 403 — never remove the underlying routes/services, only their nav entry points.
const ORGANIZATION_LINKS: NavLinkItem[] = [
  { href: "/organization/staff", label: "Staff", comingSoon: true },
  { href: "/organization/staff/roles", label: "Custom roles", comingSoon: true },
  { href: "/organization/approvals", label: "Approvals", comingSoon: true },
];

/**
 * PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md) fix: "/admin"
 * was previously mislabeled "Users" here — it actually renders AdminDashboard (the overview page),
 * not AdminUsers (the real search-by-email/id page, which lives at "/admin/users" and had no nav
 * entry at all, making it unreachable except by typing the URL directly). Also adds "/admin/businesses"
 * (new this PRSprint — see AdminBusinesses/AdminBusinessDetail).
 */
/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 10: the full Business navigation list is
 * shown to every active member while inside that organization's workspace — permission-SCOPED
 * hiding of individual items is deliberately deferred (Section 10's own "hiding a link is not
 * authorization" — the actual gate is each page/route's own server-side permission check, which
 * exists regardless of what this list shows). Rendered with the active organizationId interpolated
 * into each href.
 *
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 1, Section 15/20: narrowed to exactly the six
 * destinations with real, DB-backed functionality for initial launch — Payments/Reports/
 * Reconciliation/Documents/Audit History/Integrations were each only ever an honest "not available
 * yet" placeholder (`OrganizationUnavailableResource`), never broken/fake, but Section 15/20's own
 * explicit instruction is "do not expose a forest of coming-soon production pages merely because
 * routes exist... a narrower professional launch experience is preferred." Their page.tsx/route.ts
 * files are untouched and still reachable by direct URL (still honest, still permission-checked, no
 * dead link) — only the nav entry points, the thing a first real Business customer would actually
 * click through, are removed. Re-add an entry here the moment its destination has real functionality.
 */
export const BUSINESS_NAV_ITEMS: ReadonlyArray<{ path: string; label: string }> = [
  { path: "", label: "Dashboard" },
  { path: "/balances", label: "Outstanding Balances" },
  { path: "/customers", label: "Customers" },
  { path: "/agreements", label: "Agreements" },
  { path: "/employees", label: "Employees" },
  { path: "/settings", label: "Organization Settings" },
  // "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 23: added because this destination
  // now presents honest, real, server-derived state (never a fabricated success) — see
  // OrganizationBilling.tsx/`/api/organizations/billing`'s own doc comments.
  { path: "/settings/billing", label: "Billing & Subscription" },
];

const ADMIN_LINKS: NavLinkItem[] = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/businesses", label: "Businesses" },
  { href: "/admin/support", label: "Support queue" },
  { href: "/admin/restrictions", label: "Restrictions" },
  { href: "/admin/retention-holds", label: "Legal holds" },
  { href: "/admin/notifications", label: "Notification delivery" },
  { href: "/admin/appeals", label: "Appeals" },
  { href: "/admin/ledger", label: "Ledger" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/risk-events", label: "Risk & fraud signals" },
  { href: "/admin/verification", label: "Verification queue" },
];

interface ActiveProfileSummary {
  kind: "personal" | "business";
  displayName: string;
}

/** "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 8: workspace selector listing — distinct from ActiveProfileSummary (the pre-existing owner-only "acting as" indicator), never removed/replaced by it. */
interface WorkspaceListItem {
  organizationId: string;
  displayName: string;
}

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  // PRSprint 27 (docs/prsprints/PRSPRINT_27_DASHBOARDS_ONBOARDING_ROLE_AWARE_UX.md): "acting as
  // business" clarity — previously the active profile was only visible on the 4 pages that happened
  // to embed a ProfileSwitcher inline; a user on any other page (e.g. /organization/staff, /payments)
  // had no persistent cue of which business (if any) they were currently acting as.
  const [activeProfile, setActiveProfile] = useState<ActiveProfileSummary | null>(null);
  const [cardsEnabled, setCardsEnabled] = useState(false);
  // "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 7/8/14: the workspace selector — gated
  // behind FEATURE_B2B_ORGANIZATIONS_ENABLED (exposure only, never the security boundary; every
  // organization route/API independently re-validates membership regardless of this flag). Default
  // false/empty so every pre-existing test (which never mocks /api/organizations) renders exactly
  // as before.
  const [b2bEnabled, setB2bEnabled] = useState(false);
  const [organizations, setOrganizations] = useState<WorkspaceListItem[]>([]);
  // PRSprint 10A (docs/prsprints/PRSPRINT_10A_AUTHENTICATION_SIGNOUT_UI_REMEDIATION.md): the
  // mobile drawer state — see app-shell.css's own doc comment on `.app-nav--mobile-open` for the
  // root cause this closes (the entire nav, the only place Sign Out lived, was unconditionally
  // `display:none` below 62rem with nothing ever rendered in its place).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Closes the drawer on every navigation without an effect — React's own recommended "adjust
  // state during render" pattern for resetting state when a prop changes, so it never stays open
  // covering the new page. (An effect-based `setMobileNavOpen(false)` here would itself be a
  // cascading-render anti-pattern per this repo's `react-hooks/set-state-in-effect` rule.)
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setMobileNavOpen(false);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { email: string };
        if (!cancelled) setEmail(body.email);
      })
      .catch(() => {});
    fetch("/api/admin/whoami")
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { isAdmin: boolean };
        if (!cancelled) setIsAdmin(body.isAdmin);
      })
      .catch(() => {});
    fetch("/api/profiles/active")
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as ActiveProfileSummary;
        if (!cancelled) setActiveProfile({ kind: body.kind, displayName: body.displayName });
      })
      .catch(() => {
        if (!cancelled) setActiveProfile(null);
      });
    fetch("/api/notifications")
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { notifications: Array<{ readAt: string | null }> };
        if (!cancelled) setUnreadCount(body.notifications.filter((n) => n.readAt === null).length);
      })
      .catch(() => {
        if (!cancelled) setUnreadCount(null);
      });
    fetch("/api/feature-flags")
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { liveCardIssuanceEnabled: boolean; b2bOrganizationsEnabled?: boolean };
        if (cancelled) return;
        setCardsEnabled(body.liveCardIssuanceEnabled);
        setB2bEnabled(Boolean(body.b2bOrganizationsEnabled));
      })
      .catch(() => {});
    fetch("/api/organizations")
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { organizations: WorkspaceListItem[] };
        if (!cancelled) setOrganizations(body.organizations);
      })
      .catch(() => {
        if (!cancelled) setOrganizations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const primaryLinks = cardsEnabled ? PRIMARY_LINKS : PRIMARY_LINKS.filter((item) => item.href !== "/cards");
  const organizationPathMatch = /^\/organizations\/([^/]+)/.exec(pathname);
  const activeOrganizationId = organizationPathMatch?.[1] ?? null;
  const activeOrganizationName = organizations.find((o) => o.organizationId === activeOrganizationId)?.displayName ?? null;

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      {/*
        PRSprint 10A: the mobile topbar — this element already had CSS (`.app-topbar`,
        `display:flex` below 62rem) but nothing ever rendered it, so mobile/narrow-viewport users
        had no navigation and no Sign Out control at all. The "Log out" button here is always
        visible, independent of the menu drawer, so Sign Out never requires discovering a
        hamburger menu first.
      */}
      <div className="app-topbar">
        <Link className="app-topbar__brand" href="/dashboard">
          <span className="brand-mark" aria-hidden="true"><i>P</i><i>2</i></span>
          <span>PAY2PAY</span>
        </Link>
        {activeProfile?.kind === "business" && (
          <span className="app-topbar__acting-as" title={`Acting as ${activeProfile.displayName}`}>
            Acting as {activeProfile.displayName}
          </span>
        )}
        <div className="app-topbar__actions">
          <button
            type="button"
            className="app-topbar__button"
            aria-expanded={mobileNavOpen}
            aria-controls="app-primary-nav"
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            {mobileNavOpen ? "Close" : "Menu"}
          </button>
          <button type="button" className="app-topbar__button app-topbar__logout" onClick={() => void handleLogout()}>
            Log out
          </button>
        </div>
      </div>

      <nav id="app-primary-nav" className={`app-nav${mobileNavOpen ? " app-nav--mobile-open" : ""}`} aria-label="Primary">
        <div className="app-nav__header">
          <Link className="app-nav__brand" href="/dashboard">
            <span className="brand-mark" aria-hidden="true"><i>P</i><i>2</i></span>
            <span>PAY2PAY</span>
          </Link>
          <button type="button" className="app-nav__close" aria-label="Close menu" onClick={() => setMobileNavOpen(false)}>
            Close
          </button>
        </div>

      <div className="app-nav__section">
        {primaryLinks.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`app-nav__link${pathname === item.href ? " app-nav__link--active" : ""}`}
            aria-current={pathname === item.href ? "page" : undefined}
          >
            <span>{item.label}</span>
            {item.href === "/notifications" && unreadCount ? (
              <span className="app-nav__badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
            ) : null}
          </Link>
        ))}
      </div>

      <div className="app-nav__section">
        <span className="app-nav__section-label">Demo</span>
        {DEMO_LINKS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`app-nav__link${pathname === item.href ? " app-nav__link--active" : ""}`}
            aria-current={pathname === item.href ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </div>

      <div className="app-nav__section">
        <span className="app-nav__section-label">Account</span>
        {ACCOUNT_LINKS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`app-nav__link${pathname === item.href ? " app-nav__link--active" : ""}`}
            aria-current={pathname === item.href ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </div>

      <div className="app-nav__section">
        <span className="app-nav__section-label">Organization</span>
        {ORGANIZATION_LINKS.map((item) =>
          item.comingSoon ? (
            <div key={item.href} className="app-nav__link app-nav__link--disabled" aria-disabled="true">
              <span>{item.label}</span>
              <span className="chip chip--neutral">Coming Soon</span>
            </div>
          ) : (
            <Link
              key={item.href}
              href={item.href}
              className={`app-nav__link${pathname === item.href ? " app-nav__link--active" : ""}`}
              aria-current={pathname === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          ),
        )}
      </div>

      {b2bEnabled && (
        <div className="app-nav__section">
          <span className="app-nav__section-label">Workspace</span>
          <Link
            href="/dashboard"
            className={`app-nav__link${pathname === "/dashboard" ? " app-nav__link--active" : ""}`}
            aria-current={pathname === "/dashboard" ? "page" : undefined}
          >
            My Paid2You
          </Link>
          {organizations.map((org) => (
            <Link
              key={org.organizationId}
              href={`/organizations/${org.organizationId}`}
              className={`app-nav__link${pathname.startsWith(`/organizations/${org.organizationId}`) ? " app-nav__link--active" : ""}`}
              aria-current={pathname.startsWith(`/organizations/${org.organizationId}`) ? "page" : undefined}
            >
              {org.displayName}
            </Link>
          ))}
          <Link href="/organizations/new" className="app-nav__link">
            + Create Business Account
          </Link>
        </div>
      )}

      {b2bEnabled && activeOrganizationId && (
        <nav className="app-nav__section" aria-label={`${activeOrganizationName ?? "Business"} navigation`}>
          <span className="app-nav__section-label">{activeOrganizationName ?? "Business"}</span>
          {BUSINESS_NAV_ITEMS.map((item) => {
            const href = `/organizations/${activeOrganizationId}${item.path}`;
            const isActive = pathname === href || (item.path === "" && pathname === `/organizations/${activeOrganizationId}`);
            return (
              <Link key={href} href={href} className={`app-nav__link${isActive ? " app-nav__link--active" : ""}`} aria-current={isActive ? "page" : undefined}>
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}

      {isAdmin && (
        <div className="app-nav__section">
          <span className="app-nav__section-label">Admin</span>
          {ADMIN_LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`app-nav__link${pathname === item.href ? " app-nav__link--active" : ""}`}
              aria-current={pathname === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}

      <div className="app-nav__footer">
        {email && (
          <div className="app-nav__user">
            <strong>Signed in</strong>
            <span>{email}</span>
            {activeProfile?.kind === "business" && <span>Acting as {activeProfile.displayName}</span>}
          </div>
        )}
        <button type="button" className="app-nav__logout" onClick={() => void handleLogout()}>
          Log out
        </button>
      </div>
      </nav>
    </>
  );
}
