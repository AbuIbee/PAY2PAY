"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";

interface WorkspaceActiveResponse {
  kind: "personal" | "organization";
  organizationId?: string;
  displayName?: string | null;
  activation?: {
    active: boolean;
    onboardingComplete: boolean;
    verificationStatus: string;
    subscriptionStatus: string;
    reasons: readonly string[];
  };
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 20: the organization
 * Dashboard's real data — reuses the existing `/api/workspace/active` read (WorkspaceContextService +
 * BusinessActivationService, already membership-validated and independently-computed) rather than
 * inventing a second summary endpoint, plus an explicit `dashboard.view` check through the canonical
 * `OrganizationPermissionService` (via `/api/organizations/resource-access`) so direct URL access is
 * enforced by the real permission key, not merely by membership. Shows the organization's name and its
 * real, server-derived activation state — never a fabricated metric.
 */
export function OrganizationDashboard({ organizationId }: { organizationId: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [data, setData] = useState<WorkspaceActiveResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [result, access] = await Promise.all([
          apiFetch<WorkspaceActiveResponse>("/api/workspace/active", {
            method: "POST",
            body: JSON.stringify({ kind: "organization", organizationId }),
          }),
          apiFetch<{ allowed: boolean }>(`/api/organizations/resource-access?organizationId=${organizationId}&permission=dashboard.view`),
        ]);
        if (cancelled) return;
        if (!access.allowed) {
          setStatus("denied");
          return;
        }
        setData(result);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  if (status === "loading") return <p role="status">Loading…</p>;
  if (status === "denied") {
    return (
      <p className="form-status form-status--error" role="alert">
        You don&apos;t have permission to view this organization&apos;s dashboard.
      </p>
    );
  }
  if (status === "error" || !data || data.kind !== "organization") {
    return (
      <p className="form-status form-status--error" role="alert">
        Could not load this organization&apos;s dashboard.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <h2 style={{ margin: 0 }}>{data.displayName ?? "Business"}</h2>
      {data.activation?.active ? (
        <p className="chip chip--success">Active</p>
      ) : (
        <div>
          <p className="chip chip--warning">Not yet active</p>
          {data.activation && data.activation.reasons.length > 0 ? (
            <ul>
              {data.activation.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
