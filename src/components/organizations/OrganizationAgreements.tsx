"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";

interface AgreementSummary {
  id: string;
  status: string;
  currency: string;
  relationshipShape: "P2P" | "B2C" | "C2B" | "B2B";
  createdAt: string;
  attentionLabel: string | null;
}

type Status = "loading" | "ready" | "denied" | "error";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Final RBAC Authorization Cutover, Step 10: the
 * organization Agreements page calls the dedicated `/api/organizations/agreements` route, which
 * requires the stable `agreements.view` permission through the canonical `OrganizationPermissionService`
 * IN ADDITION TO the existing, unchanged Phase 9 party-level read check inside
 * `AgreementService.listAgreements` — membership alone is no longer sufficient. Read-only — drafting a
 * new organization agreement is a separate, already-existing flow (AgreementWorkspaceService) out of
 * this phase's scope.
 */
export function OrganizationAgreements({ organizationId }: { organizationId: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [agreements, setAgreements] = useState<AgreementSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ agreements: AgreementSummary[] }>(`/api/organizations/agreements?organizationId=${organizationId}`);
        if (!cancelled) {
          setAgreements(body.agreements);
          setStatus("ready");
        }
      } catch (error) {
        if (cancelled) return;
        setStatus(error instanceof ApiError && error.httpStatus === 403 ? "denied" : "error");
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
        You don&apos;t have permission to view this organization&apos;s agreements.
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
      <h2 style={{ marginTop: 0 }}>Agreements</h2>
      {agreements.length === 0 ? (
        <p>No agreements yet for this organization.</p>
      ) : (
        <ul style={{ display: "grid", gap: "0.75rem", padding: 0, margin: 0, listStyle: "none" }}>
          {agreements.map((agreement) => (
            <li key={agreement.id} className="early-access-form" style={{ padding: "1rem" }}>
              <Link href={`/agreements/detail?id=${agreement.id}`}>
                {agreement.relationshipShape} — {agreement.status.replaceAll("_", " ")}
              </Link>
              <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--ink-soft)" }}>
                {agreement.currency} · created {new Date(agreement.createdAt).toLocaleDateString()}
              </p>
              {agreement.attentionLabel && (
                <p style={{ margin: "0.35rem 0 0", fontSize: "0.8rem", fontWeight: 700, color: "var(--forest-800)" }}>{agreement.attentionLabel}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
