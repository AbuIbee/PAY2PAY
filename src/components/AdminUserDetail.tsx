"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { StepUpChallenge } from "./StepUpChallenge";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { useStepUpGuardedAction } from "@/lib/ui/useStepUpGuardedAction";

interface UserDetail {
  id: string;
  email: string;
  status: string;
  platformRole: "member" | "platform_admin" | "platform_owner";
  accountClassification: string;
  publicReference: string | null;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  personalProfileId: string | null;
  businessProfiles: { id: string; displayName: string; status: string }[];
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

const CLASSIFICATIONS = ["production", "internal", "qa", "demo", "automated_test"] as const;

type ChallengeKind = "suspend" | "reactivate" | "revoke_sessions" | "role_change" | "impersonation_start" | "close" | "password_reset";

export function AdminUserDetail() {
  const targetUserId = useSearchParams().get("id");
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [data, setData] = useState<UserDetail | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [actionStatus, setActionStatus] = useState<ActionStatus>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [impersonationSessionId, setImpersonationSessionId] = useState<string | null>(null);

  // Closed-beta remediation (DEF-UAT-009/DEF-UAT-010): every one of these 5 actions is correctly
  // step-up gated server-side (AdminService.requireFreshStepUp), but this component previously used
  // raw fetch() with no StepUpChallenge UI anywhere — the server's 403 STEP_UP_REQUIRED was shown to
  // the admin as an opaque, permanent failure with no way to complete the action at all.
  const suspendAction = useStepUpGuardedAction((targetUserId: string, reason: string) =>
    apiFetch("/api/admin/users/suspend", { method: "POST", body: JSON.stringify({ targetUserId, reason }) }),
  );
  const reactivateAction = useStepUpGuardedAction((targetUserId: string, reason: string) =>
    apiFetch("/api/admin/users/reactivate", { method: "POST", body: JSON.stringify({ targetUserId, reason }) }),
  );
  const revokeSessionsAction = useStepUpGuardedAction((targetUserId: string, reason: string) =>
    apiFetch("/api/admin/users/revoke-sessions", { method: "POST", body: JSON.stringify({ targetUserId, reason }) }),
  );
  const roleChangeAction = useStepUpGuardedAction((targetUserId: string, newRole: "member" | "platform_admin", reason: string) =>
    apiFetch("/api/admin/users/role", { method: "POST", body: JSON.stringify({ targetUserId, newRole, reason }) }),
  );
  const impersonationStartAction = useStepUpGuardedAction((targetUserId: string, reason: string) =>
    apiFetch<{ impersonationSessionId: string }>("/api/admin/impersonation/start", { method: "POST", body: JSON.stringify({ targetUserId, reason }) }),
  );
  // Section D (closed-beta remediation): account close/deactivate and admin-triggered password reset.
  const closeAction = useStepUpGuardedAction((targetUserId: string, reason: string) =>
    apiFetch("/api/admin/users/close", { method: "POST", body: JSON.stringify({ targetUserId, reason }) }),
  );
  const passwordResetAction = useStepUpGuardedAction((targetUserId: string, reason: string) =>
    apiFetch("/api/admin/users/password-reset", { method: "POST", body: JSON.stringify({ targetUserId, reason }) }),
  );
  const [passwordResetSent, setPasswordResetSent] = useState(false);

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
    // PRSprint 11B (docs/prsprints/PRSPRINT_11B_ADMIN_CONSOLE_CONTROLLED_SUPPORT_ACCESS.md): restore
    // this page's own "End support view" control after a refresh, if the admin already has an
    // active session open for this specific target — otherwise a reload silently lost track of it
    // (the global AdminImpersonationBanner in the app shell still shows/ends it either way, but this
    // page's own button should reflect reality too rather than falsely offering "Start" again).
    const activeResponse = await fetch("/api/admin/impersonation/active");
    if (activeResponse.ok) {
      const activeBody = (await activeResponse.json()) as {
        active: { impersonationSessionId: string; targetUserId: string } | null;
      };
      if (activeBody.active && activeBody.active.targetUserId === targetUserId) {
        setImpersonationSessionId(activeBody.active.impersonationSessionId);
      }
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

  // For non-step-up-gated actions only (classification change, ending an already-active support view).
  async function runUngatedAction(request: () => Promise<Response>) {
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

  // useStepUpGuardedAction's run() does not reject when step-up is required — it stays pending until
  // resolveChallenge()/cancelChallenge() settles it — so the challenge that's currently open must be
  // read reactively from each action's own isChallengeOpen, not set from inside a catch block (which
  // only ever sees genuine failures, since a pending promise never reaches a catch).
  const activeChallenge: ChallengeKind | null = suspendAction.isChallengeOpen
    ? "suspend"
    : reactivateAction.isChallengeOpen
      ? "reactivate"
      : revokeSessionsAction.isChallengeOpen
        ? "revoke_sessions"
        : roleChangeAction.isChallengeOpen
          ? "role_change"
          : impersonationStartAction.isChallengeOpen
            ? "impersonation_start"
            : closeAction.isChallengeOpen
              ? "close"
              : passwordResetAction.isChallengeOpen
                ? "password_reset"
                : null;

  function isCancelledChallenge(error: unknown) {
    return error instanceof Error && error.message === "Verification was cancelled.";
  }

  async function runGuardedAction<R>(run: () => Promise<R>, onSuccess?: (result: R) => void) {
    setActionStatus("working");
    setActionError(null);
    try {
      const result = await run();
      onSuccess?.(result);
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

  function revokeSessions() {
    if (!data) return;
    return runGuardedAction(() => revokeSessionsAction.run(data.id, reason));
  }

  function changeRole(newRole: "member" | "platform_admin") {
    if (!data) return;
    return runGuardedAction(() => roleChangeAction.run(data.id, newRole, reason));
  }

  function startImpersonation() {
    if (!data) return;
    return runGuardedAction(
      () => impersonationStartAction.run(data.id, reason),
      (result) => setImpersonationSessionId(result.impersonationSessionId),
    );
  }

  function close() {
    if (!data) return;
    return runGuardedAction(() => closeAction.run(data.id, reason));
  }

  function sendPasswordReset() {
    if (!data) return;
    setPasswordResetSent(false);
    return runGuardedAction(
      () => passwordResetAction.run(data.id, reason),
      () => setPasswordResetSent(true),
    );
  }

  function resolveActiveChallenge() {
    switch (activeChallenge) {
      case "suspend":
        suspendAction.resolveChallenge();
        break;
      case "reactivate":
        reactivateAction.resolveChallenge();
        break;
      case "revoke_sessions":
        revokeSessionsAction.resolveChallenge();
        break;
      case "role_change":
        roleChangeAction.resolveChallenge();
        break;
      case "impersonation_start":
        impersonationStartAction.resolveChallenge();
        break;
      case "close":
        closeAction.resolveChallenge();
        break;
      case "password_reset":
        passwordResetAction.resolveChallenge();
        break;
    }
  }

  function cancelActiveChallenge() {
    switch (activeChallenge) {
      case "suspend":
        suspendAction.cancelChallenge();
        break;
      case "reactivate":
        reactivateAction.cancelChallenge();
        break;
      case "revoke_sessions":
        revokeSessionsAction.cancelChallenge();
        break;
      case "role_change":
        roleChangeAction.cancelChallenge();
        break;
      case "impersonation_start":
        impersonationStartAction.cancelChallenge();
        break;
      case "close":
        closeAction.cancelChallenge();
        break;
      case "password_reset":
        passwordResetAction.cancelChallenge();
        break;
    }
  }

  const ACTIVE_CHALLENGE_LABELS: Record<ChallengeKind, string> = {
    suspend: "admin_suspend_user",
    reactivate: "admin_reactivate_user",
    revoke_sessions: "admin_revoke_sessions",
    role_change: "admin_role_change",
    impersonation_start: "admin_start_impersonation",
    close: "admin_user_close",
    password_reset: "admin_password_reset_send",
  };

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
        <p style={{ margin: 0 }}>Account reference: {data.publicReference ?? "(not yet generated)"}</p>
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
              {a.currentVersionNumber !== null ? ` — v${a.currentVersionNumber}` : ""}
              {a.currentVersionSigned ? " — signed" : " — not yet signed"}
              {a.hasExecutedPdf ? " — executed PDF available" : ""}
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

            <button
              type="button"
              className="button button--ghost"
              disabled={actionStatus === "working" || !reason.trim()}
              onClick={() => void revokeSessions()}
            >
              Revoke sessions
            </button>

            <button
              type="button"
              className="button button--ghost"
              disabled={actionStatus === "working" || !reason.trim() || data.status === "closed"}
              onClick={() => {
                if (window.confirm("Close this account? It will no longer be able to sign in. Payment history, agreements, and audit records are preserved.")) {
                  void close();
                }
              }}
            >
              Close account
            </button>

            <button
              type="button"
              className="button button--ghost"
              disabled={actionStatus === "working" || !reason.trim()}
              onClick={() => void sendPasswordReset()}
            >
              Send password reset email
            </button>
          </div>

          {data.status === "closed" ? <p className="form-status">This account is closed.</p> : null}
          {passwordResetSent ? <p className="form-status">Password reset email sent.</p> : null}

          {isOwner ? (
            <div className="hero__actions">
              {data.platformRole === "member" ? (
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={actionStatus === "working" || !reason.trim()}
                  onClick={() => void changeRole("platform_admin")}
                >
                  Promote to Platform Admin
                </button>
              ) : (
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={actionStatus === "working" || !reason.trim()}
                  onClick={() => void changeRole("member")}
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
                void runUngatedAction(() =>
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
                  void runUngatedAction(async () => {
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
              onClick={() => void startImpersonation()}
            >
              Start support view (read-only)
            </button>
          )}

          {activeChallenge && (
            <StepUpChallenge
              action={ACTIVE_CHALLENGE_LABELS[activeChallenge]}
              actionDescription="complete this administrative action"
              onVerified={resolveActiveChallenge}
              onCancel={cancelActiveChallenge}
            />
          )}
        </div>
      )}
    </div>
  );
}
