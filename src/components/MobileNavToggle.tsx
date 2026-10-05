"use client";

import { useState } from "react";

/**
 * P0-11 (Homepage Visual Parity): the approved header design authority specifies a center nav of
 * exactly Personal / Business / Support — replaces the prior anchor-link set. Personal/Business
 * point at the homepage's own workspace-comparison cards (real ids set on page.tsx); Support points
 * at the existing, real /support route.
 */
const NAV_ITEMS = [
  { href: "/#personal-workspace", label: "Personal" },
  { href: "/#business-workspace", label: "Business" },
  { href: "/support", label: "Support" },
];

export function MobileNavToggle() {
  const [open, setOpen] = useState(false);

  return (
    <div className="nav-shell">
      <nav className="desktop-nav" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => (
          <a key={item.label} href={item.href}>{item.label}</a>
        ))}
      </nav>
      <button
        type="button"
        className="menu-button"
        aria-expanded={open}
        aria-controls="mobile-navigation"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((value) => !value)}
      >
        <span />
        <span />
      </button>
      <nav
        id="mobile-navigation"
        className={`mobile-nav${open ? " mobile-nav--open" : ""}`}
        aria-label="Mobile navigation"
      >
        {NAV_ITEMS.map((item) => (
          <a key={item.label} href={item.href} onClick={() => setOpen(false)}>{item.label}</a>
        ))}
      </nav>
    </div>
  );
}
