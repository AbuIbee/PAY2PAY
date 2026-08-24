"use client";

import { useState } from "react";

const NAV_ITEMS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#use-cases", label: "Use cases" },
  { href: "#main-content", label: "Why PAY2PAY" },
  { href: "/demo", label: "Try the demo" },
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
