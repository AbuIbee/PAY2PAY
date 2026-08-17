"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

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
  agreements: { id: string; status: string; relationshipShape: string }[];
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

  async function runAction(request: () => Promise<Response>) {
    setActionStatus("working");
    setActionError(null);
    const response = await request();
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setActionError(body?.message ?? "That action could not be completed.");
      setActionStatus("error");
      return;
    }
    setActionStatus("idle");
    await load();
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
              onClick={() =>
                void runAction(() =>
                  fetch("/api/admin/businesses/suspend", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ targetBusinessId: data.id, reason }),
                  }),
                )
              }
            >
              Suspend
            </button>
          ) : (
            <button
              type="button"
              className="button button--primary"
              disabled={actionStatus === "working" || !reason.trim()}
              onClick={() =>
                void runAction(() =>
                  fetch("/api/admin/businesses/reactivate", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ targetBusinessId: data.id, reason }),
                  }),
                )
              }
            >
              Reactivate
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
