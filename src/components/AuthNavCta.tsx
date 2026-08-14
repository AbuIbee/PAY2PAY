"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Sprint 18B: the marketing header's call-to-action must reflect real
 * session state — a logged-in visitor on the public site should see
 * "Dashboard", not a static "Sign in" link that ignores who they are.
 * Presentation-only, same pattern as AdminNavLink: every /api/* route
 * independently re-checks the session, this just picks the right label.
 */
export function AuthNavCta() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((response) => {
        if (!cancelled) setLoggedIn(response.ok);
      })
      .catch(() => {
        if (!cancelled) setLoggedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loggedIn === null) return null;

  return loggedIn ? (
    <Link href="/dashboard" className="button button--ghost" style={{ marginInlineEnd: "0.75rem" }}>
      Dashboard
    </Link>
  ) : (
    <Link href="/login" className="button button--ghost" style={{ marginInlineEnd: "0.75rem" }}>
      Sign in
    </Link>
  );
}
