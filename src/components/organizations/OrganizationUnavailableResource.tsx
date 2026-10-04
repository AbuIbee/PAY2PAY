"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";

type Status = "checking" | "allowed" | "denied" | "error";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 6/7/20: shared
 * renderer for a Business-nav destination that has no feature of its own built yet (Payments
 * org-level view, Reports, Reconciliation, Documents, Audit History, Integrations). Never fabricates
 * counts/records — the only two honest states are "you don't have permission to view this"
 * (server-checked via the canonical `OrganizationPermissionService`, never inferred from the nav link
 * being visible) and "this isn't available yet." No `permissionKey` here duplicates a page that
 * already has its own real data route.
 */
export function OrganizationUnavailableResource({
  organizationId,
  permissionKey,
  title,
  message,
}: {
  organizationId: string;
  permissionKey: string;
  title: string;
  message: string;
}) {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiFetch<{ allowed: boolean }>(`/api/organizations/resource-access?organizationId=${organizationId}&permission=${permissionKey}`);
        if (!cancelled) setStatus(result.allowed ? "allowed" : "denied");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, permissionKey]);

  if (status === "checking") return <p role="status">Loading…</p>;

  if (status === "denied") {
    return (
      <p className="form-status form-status--error" role="alert">
        You don&apos;t have permission to view this section.
      </p>
    );
  }

  if (status === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong. Please try again.
      </p>
    );
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p>{message}</p>
    </div>
  );
}
