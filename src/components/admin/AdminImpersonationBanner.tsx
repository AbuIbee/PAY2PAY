"use client";

import { useCallback, useEffect, useState } from "react";

interface ActiveImpersonation {
  impersonationSessionId: string;
  targetUserId: string;
  startedAt: string;
  view: { email: string };
}

/**
 * PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md): mounted
 * once in the authenticated shell (src/app/(app)/layout.tsx), not just on the one admin page a
 * support view happened to be started from — a refresh or a navigation to any other page previously
 * made an active support view invisible to the admin (its id lived only in that one page's React
 * state) while it stayed open on the server indefinitely. This polls once on mount for the acting
 * admin's own active session and, if one exists, stays visible with an immediate "End support view"
 * control everywhere in the authenticated app until it is ended — closing the "hidden persistent
 * support session" gap this PRSprint's Goal names explicitly.
 *
 * Silent no-op for a non-admin or unauthenticated visitor (a 401/403 from the active-check just
 * leaves the banner unrendered), matching AdminGate/AdminNavLink's own "never surface a raw error
 * for a routine presence check" convention.
 */
export function AdminImpersonationBanner() {
  const [active, setActive] = useState<ActiveImpersonation | null>(null);
  const [ending, setEnding] = useState(false);

  const check = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/impersonation/active");
      if (!response.ok) return;
      const body = (await response.json()) as { active: ActiveImpersonation | null };
      setActive(body.active);
    } catch {
      // Silent — this is a presence check, not a required page dependency.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await check();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [check]);

  if (!active) return null;

  async function handleEnd() {
    setEnding(true);
    const response = await fetch("/api/admin/impersonation/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ impersonationSessionId: active!.impersonationSessionId }),
    });
    setEnding(false);
    if (response.ok) setActive(null);
  }

  return (
    <div
      role="alert"
      className="badge"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        padding: "0.5rem 1rem",
        flexWrap: "wrap",
      }}
    >
      <span>
        ADMIN SUPPORT VIEW ACTIVE — read-only — viewing {active.view.email} — started{" "}
        {new Date(active.startedAt).toLocaleString()}
      </span>
      <button type="button" className="button button--ghost" disabled={ending} onClick={() => void handleEnd()}>
        End support view
      </button>
    </div>
  );
}
