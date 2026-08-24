"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { StepUpChallenge } from "../StepUpChallenge";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { useStepUpGuardedAction } from "@/lib/ui/useStepUpGuardedAction";

interface BusinessDetail {
  id: string;
  legalBusinessName: string;
  displayName: string;
  entityType: string;
  country: string;
  state: string;
  status: string;
  ownerUserId: string;
  ownerEmail: string;
  ownerPlatformRole: string;
  members: { userId: string; email: string; role: string; isAuthorizedRepresentative: boolean }[];
  agreements: {
    id: string;
    status: string;
    relationshipShape: string;
    currentVersionNumber: number | null;
    currentVersionSigned: boolean;
    hasExecutedPdf: boolean;
  }[];
}

type LoadStatus = "loading" | "ready" | "unauthorized" | "forbidden" | "error";
type ActionStatus = "idle" | "working" | "error";

/** PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md) — mirrors AdminUserDetail.tsx's structure for a business_profile target. No impersonation/role-change here: those are user-identity concepts with no business equivalent. */
export function AdminBusinessDetail() {
  const targetBusinessId = useSearchParams().get("id");
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [data, setData] = useState<BusinessDetail | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatus>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  // Closed-beta remediation (DEF-UAT-009/DEF-UAT-010): identical fix to AdminUserDetail.tsx — these
  // two actions are step-up gated server-side but this component had no StepUpChallenge UI at all.
  const suspendAction = useStepUpGuardedAction((targetBusinessId: string, reason: string) =>
    apiFetch("/api/admin/businesses/suspend", { method: "POST", body: JSON.stringify({ targetBusinessId, reason }) }),
  );
  const reactivateAction = useStepUpGuardedAction((targetBusinessId: string, reason: string) =>
    apiFetch("/api/admin/businesses/reactivate", { method: "POST", body: JSON.stringify({ targetBusinessId, reason }) }),
  );

  const load = useCallback(async () => {
    if (!targetBusinessId) {
      setLoadStatus("error");
      return;
    }
    const response = await fetch(`/api/admin/businesses/detail?id=${encodeURIComponent(targetBusinessId)}`);
    if (response.status === 401) return setLoadStatus("unauthorized");
    if (response.status === 403) return setLoadStatus("forbidden");
    if (!response.ok) return setLoadStatus("error");
    setData((await response.json()) as BusinessDetail);
    setLoadStatus("ready");
  }, [targetBusinessId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await load();
      } catch {
        if (!cancelled) setLoadStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const activeChallenge: "suspend" | "reactivate" | null = suspendAction.isChallengeOpen
    ? "suspend"
    : reactivateAction.isChallengeOpen
      ? "reactivate"
      : null;

  function isCancelledChallenge(error: unknown) {
    return error instanceof Error && error.message === "Verification was cancelled.";
  }

  async function runGuardedAction(run: () => Promise<unknown>) {
    setActionStatus("working");
    setActionError(null);
    try {
      await run();
      setActionStatus("idle");
      await load();
    } catch (error) {
      if (isCancelledChallenge(error)) {
        setActionStatus("idle");
        return;
      }
      setActionStatus("error");
      setActionError(error instanceof ApiError ? error.message : "That action could not be completed.");
    }
  }

  function suspend() {
    if (!data) return;
    return runGuardedAction(() => suspendAction.run(data.id, reason));
  }

  function reactivate() {
    if (!data) return;
    return runGuardedAction(() => reactivateAction.run(data.id, reason));
  }

  function resolveActiveChallenge() {
    if (activeChallenge === "suspend") suspendAction.resolveChallenge();
    else if (activeChallenge === "reactivate") reactivateAction.resolveChallenge();
  }

  function cancelActiveChallenge() {
    if (activeChallenge === "suspend") suspendAction.cancelChallenge();
    else if (activeChallenge === "reactivate") reactivateAction.cancelChallenge();
  }

  if (loadStatus === "loading") return <p role="status">Loading business…</p>;
  if (loadStatus === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert">
        You need to <a href="/login">sign in</a> to view this business.
      </p>
    );
  }
  if (loadStatus === "forbidden") {
    return (
      <p className="form-status form-status--error" role="alert">
        You do not have administrative access.
      </p>
    );
  }
  if (loadStatus === "error" || !data) {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading this business. Please try again.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem" }}>
      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{data.displayName}</h2>
        <p style={{ margin: 0 }}>Legal name: {data.legalBusinessName}</p>
        <p style={{ margin: 0 }}>Status: {data.status}</p>
        <p style={{ margin: 0 }}>Entity type: {data.entityType}</p>
        <p style={{ margin: 0 }}>Location: {data.state}, {data.country}</p>
        <p style={{ margin: 0 }}>
          Owner: {data.ownerEmail} ({data.ownerPlatformRole})
        </p>
      </div>

      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Staff</h2>
        {data.members.length === 0 ? (
          <p style={{ margin: 0 }}>No active staff members.</p>
        ) : (
          data.members.map((member) => (
            <p style={{ margin: 0 }} key={member.userId}>
              {member.email} — {member.role}
              {member.isAuthorizedRepresentative ? " (authorized representative)" : ""}
            </p>
          ))
        )}
      </div>

      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Agreements</h2>
        {data.agreements.length === 0 ? (
          <p style={{ margin: 0 }}>None.</p>
        ) : (
          data.agreements.map((a) => (
            <p style={{ margin: 0 }} key={a.id}>
              {a.relationshipShape} — {a.status.replaceAll("_", " ")}
              {a.currentVersionNumber !== null ? ` — v${a.currentVersionNumber}` : ""}
              {a.currentVersionSigned ? " — signed" : " — not yet signed"}
              {a.hasExecutedPdf ? " — executed PDF available" : ""}
            </p>
          ))
        )}
      </div>

      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Administrative actions</h2>
        <div className="field">
          <label htmlFor="admin-business-reason">Reason</label>
          <input id="admin-business-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>

        {actionError ? (
          <p className="form-status form-status--error" role="alert">
            {actionError}
          </p>
        ) : null}

        <div className="hero__actions">
          {data.status === "active" ? (
            <button
              type="button"
              className="button button--ghost"
              disabled={actionStatus === "working" || !reason.trim()}
              onClick={() => void suspend()}
            >
              Suspend
            </button>
          ) : (
            <button
              type="button"
              className="button button--primary"
              disabled={actionStatus === "working" || !reason.trim()}
              onClick={() => void reactivate()}
            >
              Reactivate
            </button>
          )}
        </div>

        {activeChallenge && (
          <StepUpChallenge
            action={activeChallenge === "suspend" ? "admin_suspend_business" : "admin_reactivate_business"}
            actionDescription="complete this administrative action"
            onVerified={resolveActiveChallenge}
            onCancel={cancelActiveChallenge}
          />
        )}
      </div>
    </div>
  );
}
