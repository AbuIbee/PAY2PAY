"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";

export interface ActiveParty {
  kind: "personal" | "business";
  id: string;
  displayName: string;
}

interface ActiveProfileResponse {
  kind: "personal" | "business";
  personalProfileId?: string;
  businessProfileId?: string;
  displayName: string;
}

/** Sprint 18B: resolves the caller's currently-active acting identity (personal or business) — the "party" every relationship/financial-account endpoint is scoped by. */
export function useActiveParty(): { party: ActiveParty | null; status: "loading" | "ready" | "error" } {
  const [party, setParty] = useState<ActiveParty | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    apiFetch<ActiveProfileResponse>("/api/profiles/active")
      .then((body) => {
        if (cancelled) return;
        const id = body.kind === "personal" ? body.personalProfileId : body.businessProfileId;
        if (!id) {
          setStatus("error");
          return;
        }
        setParty({ kind: body.kind, id, displayName: body.displayName });
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { party, status };
}
