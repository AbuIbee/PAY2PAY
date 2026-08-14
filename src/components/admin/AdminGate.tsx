"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";

type GateState = "checking" | "allowed" | "denied";

/**
 * Sprint 18B: presentation-only admin gate reused across every new admin
 * page in this fork — mirrors AdminNavLink's own doc comment ("hiding the
 * link is not the security boundary... every /api/admin/* route
 * independently re-checks"). Shows children only once /api/admin/whoami
 * confirms isAdmin; a denied/unauthenticated visitor sees a safe message,
 * never a raw 403.
 */
export function AdminGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>("checking");

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ isAdmin: boolean }>("/api/admin/whoami")
      .then((body) => {
        if (!cancelled) setState(body.isAdmin ? "allowed" : "denied");
      })
      .catch(() => {
        if (!cancelled) setState("denied");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking") return <p role="status">Loading…</p>;
  if (state === "denied") {
    return (
      <div className="form-status form-status--error" role="alert">
        This page is only available to PAY2PAY administrators.
      </div>
    );
  }
  return <>{children}</>;
}
