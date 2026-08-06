"use client";

import { useState } from "react";

/**
 * Deliberately minimal client component: demonstrates the server/client
 * boundary convention for Phase 0 (interactive state requires "use client";
 * everything else in the shell stays a server component by default). Not a
 * real navigation menu — there's nothing to navigate to yet.
 */
export function MobileNavToggle() {
  const [open, setOpen] = useState(false);

  return (
    <button
      type="button"
      className="button"
      aria-expanded={open}
      aria-controls="mobile-nav-placeholder"
      onClick={() => setOpen((value) => !value)}
    >
      {open ? "Close menu" : "Open menu"}
    </button>
  );
}
