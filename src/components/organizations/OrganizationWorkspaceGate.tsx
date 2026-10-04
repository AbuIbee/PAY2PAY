"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";

interface WorkspaceActiveResponse {
  kind: "personal" | "organization";
  organizationId?: string;
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 8: the organization route shell's own client
 * presence check — mirrors OnboardingGate's identical "silent client-side check, redirect on
 * mismatch" pattern. The URL's `organizationId` is UNTRUSTED: this calls the existing, already-tested
 * `WorkspaceContextService.resolveWorkspaceContext` (via POST /api/workspace/active) to re-verify
 * active membership from the database — no new authorization logic is invented here. If membership is
 * missing, removed, or the organization itself is no longer valid, that call silently falls back to
 * `{ kind: "personal" }` (never a distinguishing error — see WorkspaceContextService's own doc
 * comment), and this gate redirects to My Paid2You rather than rendering the child route's content.
 *
 * This is UX only, not the real security boundary: every page nested under this gate fetches its own
 * data from its own API route, which independently re-checks membership/capability server-side and
 * fails closed on its own (matching this codebase's established "every page independently checks"
 * convention — see src/app/(app)/layout.tsx's own doc comment). A user who bypasses this client check
 * entirely (disabled JS, a direct API call) gets nothing more than an empty shell — no protected data
 * is reachable without the underlying API route's own authorization passing.
 */
export function OrganizationWorkspaceGate({ organizationId, children }: { organizationId: string; children: React.ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<"checking" | "allowed" | "denied">("checking");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiFetch<WorkspaceActiveResponse>("/api/workspace/active", {
          method: "POST",
          body: JSON.stringify({ kind: "organization", organizationId }),
        });
        if (cancelled) return;
        if (result.kind === "organization" && result.organizationId === organizationId) {
          setStatus("allowed");
        } else {
          setStatus("denied");
          router.replace("/dashboard");
        }
      } catch {
        if (cancelled) return;
        setStatus("denied");
        router.replace("/dashboard");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, router]);

  if (status === "checking") return <p role="status">Loading…</p>;
  if (status === "denied") return null;
  return <>{children}</>;
}
