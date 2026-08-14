"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatDateTime } from "@/lib/ui/date";
import { businessCapabilityLabel } from "@/lib/ui/statusLabels";

interface ApprovalRequest {
  id: string;
  proposedByStaffId: string;
  relatedAgreementId: string | null;
  actionType: string;
  reasonFlagged: string;
  status: string;
  createdAt: string;
}

type LoadState = "loading" | "ready" | "not_business" | "error";

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/**
 * Sprint 4/18B: pending approval-request queue. decideAction enforces
 * no-self-approval and owner-required server-side (see approvalService.ts)
 * — this UI still disables the Approve/Reject buttons for a request the
 * viewer themselves proposed, so a self-approval attempt never even reaches
 * the network call, rather than relying solely on the eventual 403.
 */
export function OrganizationApprovals() {
  const [state, setState] = useState<LoadState>("loading");
  const [businessProfileId, setBusinessProfileId] = useState<string | null>(null);
  const [myStaffId, setMyStaffId] = useState<string | null>(null);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function refresh() {
    try {
      const [active, me] = await Promise.all([
        apiFetch<{ kind: string; businessProfileId?: string }>("/api/profiles/active"),
        apiFetch<{ id: string }>("/api/auth/me"),
      ]);
      if (active.kind !== "business" || !active.businessProfileId) {
        setState("not_business");
        return;
      }
      setBusinessProfileId(active.businessProfileId);
      const staffBody = await apiFetch<{ staff: Array<{ id: string; userId: string }> }>(
        `/api/staff?businessProfileId=${active.businessProfileId}`,
      );
      setMyStaffId(staffBody.staff.find((s) => s.userId === me.id)?.id ?? null);
      const body = await apiFetch<{ requests: ApprovalRequest[] }>(
        `/api/staff/approval-requests?businessProfileId=${active.businessProfileId}`,
      );
      setRequests(body.requests);
      setState("ready");
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, []);

  async function handleDecide(requestId: string, decision: "approved" | "rejected") {
    if (!businessProfileId) return;
    setActioningId(requestId);
    setErrorMessage(null);
    try {
      await apiFetch("/api/staff/approval-requests/decide", {
        method: "POST",
        body: JSON.stringify({ businessProfileId, requestId, decision }),
      });
      await refresh();
    } catch {
      setErrorMessage("Couldn't record that decision. Please try again.");
    } finally {
      setActioningId(null);
    }
  }

  if (state === "loading") return <div className="skeleton skeleton--card" aria-hidden="true" />;
  if (state === "not_business") {
    return (
      <div className="empty-state">
        <h3>No business selected</h3>
        <p>Switch to a business profile to review pending approvals.</p>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="form-status form-status--error" role="alert">
        Something went wrong loading pending approvals. Please try again.
      </div>
    );
  }

  if (requests.length === 0) {
    return (
      <div className="empty-state">
        <h3>Nothing pending</h3>
        <p>Approval requests that need a second person&apos;s sign-off will show up here.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {errorMessage && <p className="form-status form-status--error" role="alert">{errorMessage}</p>}
      {requests.map((request) => {
        const isOwnProposal = myStaffId !== null && request.proposedByStaffId === myStaffId;
        return (
          <div key={request.id} className="card">
            <div className="card__header">
              <h2>{businessCapabilityLabel[request.actionType] ?? request.actionType}</h2>
              <span className="chip chip--warning">Pending</span>
            </div>
            <p style={{ color: "var(--ink-soft)" }}>{request.reasonFlagged}</p>
            <p style={{ fontSize: "0.78rem", color: "var(--ink-soft)" }}>
              Proposed by {shortId(request.proposedByStaffId)} on {formatDateTime(request.createdAt)}
            </p>
            {isOwnProposal && (
              <p className="chip chip--neutral" style={{ marginBottom: "0.75rem" }}>
                You proposed this — a different approver is required
              </p>
            )}
            <div style={{ display: "flex", gap: "0.75rem" }}>
              <button
                type="button"
                className="button button--primary"
                disabled={isOwnProposal || actioningId === request.id}
                onClick={() => void handleDecide(request.id, "approved")}
              >
                Approve
              </button>
              <button
                type="button"
                className="button button--ghost"
                disabled={isOwnProposal || actioningId === request.id}
                onClick={() => void handleDecide(request.id, "rejected")}
              >
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
