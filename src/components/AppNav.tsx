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
const PRIMARY_LINKS: NavLinkItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/connections", label: "Connections" },
  { href: "/agreements", label: "Agreements" },
  { href: "/payments", label: "Payments" },
  { href: "/payment-methods", label: "Payment Methods" },
  { href: "/notifications", label: "Notifications" },
  { href: "/support", label: "Support" },
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
  { href: "/admin/notifications", label: "Email delivery" },
  { href: "/admin/appeals", label: "Appeals" },
  { href: "/admin/ledger", label: "Ledger" },
  { href: "/admin/audit", label: "Audit log" },
];

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
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
    fetch("/api/notifications")
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { notifications: Array<{ readAt: string | null }> };
        if (!cancelled) setUnreadCount(body.notifications.filter((n) => n.readAt === null).length);
      })
      .catch(() => {
        if (!cancelled) setUnreadCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

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
        {PRIMARY_LINKS.map((item) => (
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
