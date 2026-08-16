"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface UserDetail {
  id: string;
  email: string;
  status: string;
  platformRole: "member" | "platform_admin" | "platform_owner";
  accountClassification: string;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  personalProfileId: string | null;
  businessProfiles: { id: string; displayName: string; status: string }[];
  agreements: { id: string; status: string; relationshipShape: string }[];
}

type LoadStatus = "loading" | "ready" | "unauthorized" | "forbidden" | "error";
type ActionStatus = "idle" | "working" | "error";

const CLASSIFICATIONS = ["production", "internal", "qa", "demo", "automated_test"] as const;

export function AdminUserDetail() {
  const targetUserId = useSearchParams().get("id");
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [data, setData] = useState<UserDetail | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [actionStatus, setActionStatus] = useState<ActionStatus>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [impersonationSessionId, setImpersonationSessionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!targetUserId) {
      setLoadStatus("error");
      return;
    }
    const [detailResponse, whoAmIResponse] = await Promise.all([
      fetch(`/api/admin/users/detail?id=${encodeURIComponent(targetUserId)}`),
      fetch("/api/admin/whoami"),
    ]);
    if (detailResponse.status === 401) return setLoadStatus("unauthorized");
    if (detailResponse.status === 403) return setLoadStatus("forbidden");
    if (!detailResponse.ok) return setLoadStatus("error");
    setData((await detailResponse.json()) as UserDetail);
    if (whoAmIResponse.ok) {
      const who = (await whoAmIResponse.json()) as { platformRole: string };
      setIsOwner(who.platformRole === "platform_owner");
    }
    setLoadStatus("ready");
  }, [targetUserId]);

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

  if (loadStatus === "loading") return <p role="status">Loading user…</p>;
  if (loadStatus === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert">
        You need to <a href="/login">sign in</a> to view this user.
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
        Something went wrong loading this user. Please try again.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem" }}>
      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{data.email}</h2>
        <p style={{ margin: 0 }}>Status: {data.status}</p>
        <p style={{ margin: 0 }}>Platform role: {data.platformRole}</p>
        <p style={{ margin: 0 }}>Classification: {data.accountClassification}</p>
        <p style={{ margin: 0 }}>Email verified: {data.emailVerifiedAt ? "yes" : "no"}</p>
        <p style={{ margin: 0 }}>Last login: {data.lastLoginAt ? new Date(data.lastLoginAt).toLocaleString() : "never"}</p>
      </div>

      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Businesses</h2>
        {data.businessProfiles.length === 0 ? (
          <p style={{ margin: 0 }}>None.</p>
        ) : (
          data.businessProfiles.map((b) => (
            <p style={{ margin: 0 }} key={b.id}>
              {b.displayName} — {b.status}
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

      {data.platformRole === "platform_owner" ? (
        <p className="form-status">Platform Owner accounts cannot be modified through this console.</p>
      ) : (
        <div className="early-access-form">
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Administrative actions</h2>
          <div className="field">
            <label htmlFor="admin-reason">Reason</label>
            <input id="admin-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
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
                    fetch("/api/admin/users/suspend", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ targetUserId: data.id, reason }),
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
                    fetch("/api/admin/users/reactivate", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ targetUserId: data.id, reason }),
                    }),
                  )
                }
              >
                Reactivate
              </button>
            )}

            <button
              type="button"
              className="button button--ghost"
              disabled={actionStatus === "working" || !reason.trim()}
              onClick={() =>
                void runAction(() =>
                  fetch("/api/admin/users/revoke-sessions", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ targetUserId: data.id, reason }),
                  }),
                )
              }
            >
              Revoke sessions
            </button>
          </div>

          {isOwner ? (
            <div className="hero__actions">
              {data.platformRole === "member" ? (
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={actionStatus === "working" || !reason.trim()}
                  onClick={() =>
                    void runAction(() =>
                      fetch("/api/admin/users/role", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ targetUserId: data.id, newRole: "platform_admin", reason }),
                      }),
                    )
                  }
                >
                  Promote to Platform Admin
                </button>
              ) : (
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={actionStatus === "working" || !reason.trim()}
                  onClick={() =>
                    void runAction(() =>
                      fetch("/api/admin/users/role", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ targetUserId: data.id, newRole: "member", reason }),
                      }),
                    )
                  }
                >
                  Demote to Member
                </button>
              )}
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="admin-classification">Account classification</label>
            <select
              id="admin-classification"
              value={data.accountClassification}
              onChange={(event) =>
                void runAction(() =>
                  fetch("/api/admin/users/classification", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ targetUserId: data.id, classification: event.target.value }),
                  }),
                )
              }
            >
              {CLASSIFICATIONS.map((classification) => (
                <option key={classification} value={classification}>
                  {classification}
                </option>
              ))}
            </select>
          </div>

          {impersonationSessionId ? (
            <div>
              <p className="badge">ADMIN SUPPORT VIEW ACTIVE — read-only</p>
              <button
                type="button"
                className="button button--ghost"
                disabled={actionStatus === "working"}
                onClick={() =>
                  void runAction(async () => {
                    const response = await fetch("/api/admin/impersonation/end", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ impersonationSessionId }),
                    });
                    if (response.ok) setImpersonationSessionId(null);
                    return response;
                  })
                }
              >
                End support view
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button button--ghost"
              disabled={actionStatus === "working" || !reason.trim()}
              onClick={() =>
                void runAction(async () => {
                  const response = await fetch("/api/admin/impersonation/start", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ targetUserId: data.id, reason }),
                  });
                  if (response.ok) {
                    const body = (await response.json()) as { impersonationSessionId: string };
                    setImpersonationSessionId(body.impersonationSessionId);
                  }
                  return response;
                })
              }
            >
              Start support view (read-only)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
