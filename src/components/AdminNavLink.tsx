"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Sprint 6A: "Normal members must not see admin navigation." This is presentation-only — hiding
 * the link is not the security boundary (every /api/admin/* route independently re-checks
 * platformRole from the trusted session), it just avoids showing a link a Member would only ever
 * get a 403 from.
 */
export function AdminNavLink() {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/whoami")
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { isAdmin: boolean };
        if (!cancelled) setIsAdmin(body.isAdmin);
      })
      .catch(() => {
        // Not logged in, or the check failed — no admin link either way.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isAdmin) return null;

  return (
    <Link href="/admin" className="button button--ghost" style={{ marginInlineEnd: "0.75rem" }}>
      Admin
    </Link>
  );
}
