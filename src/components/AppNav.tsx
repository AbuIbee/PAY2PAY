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

const ADMIN_LINKS: NavLinkItem[] = [
  { href: "/admin", label: "Users" },
  { href: "/admin/support", label: "Support queue" },
  { href: "/admin/restrictions", label: "Restrictions" },
  { href: "/admin/retention-holds", label: "Legal holds" },
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
    <nav className="app-nav" aria-label="Primary">
      <Link className="app-nav__brand" href="/dashboard">
        <span className="brand-mark" aria-hidden="true"><i>P</i><i>2</i></span>
        <span>PAY2PAY</span>
      </Link>

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
  );
}
