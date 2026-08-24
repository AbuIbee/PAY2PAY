"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface NavLinkItem {
  href: string;
  label: string;
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
  { href: "/connections", label: "Connections" },
  { href: "/agreements", label: "Agreements" },
  { href: "/payments", label: "Payments" },
  { href: "/payment-methods", label: "Payment Methods" },
  { href: "/cards", label: "Cards" },
  { href: "/notifications", label: "Notifications" },
  { href: "/support", label: "Support" },
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

const ORGANIZATION_LINKS: NavLinkItem[] = [
  { href: "/organization/staff", label: "Staff" },
  { href: "/organization/staff/roles", label: "Custom roles" },
  { href: "/organization/approvals", label: "Approvals" },
];

/**
 * PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md) fix: "/admin"
 * was previously mislabeled "Users" here — it actually renders AdminDashboard (the overview page),
 * not AdminUsers (the real search-by-email/id page, which lives at "/admin/users" and had no nav
 * entry at all, making it unreachable except by typing the URL directly). Also adds "/admin/businesses"
 * (new this PRSprint — see AdminBusinesses/AdminBusinessDetail).
 */
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
        const body = (await response.json()) as { liveCardIssuanceEnabled: boolean };
        if (!cancelled) setCardsEnabled(body.liveCardIssuanceEnabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const primaryLinks = cardsEnabled ? PRIMARY_LINKS : PRIMARY_LINKS.filter((item) => item.href !== "/cards");

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
        {ORGANIZATION_LINKS.map((item) => (
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
