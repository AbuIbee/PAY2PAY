"use client";

import { useEffect, useId, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";

interface InvitationItem {
  id: string;
  email: string;
  roleId: string | null;
  expiresAt: string;
  createdAt: string;
}

interface RoleOption {
  id: string;
  displayName: string;
}

type Status = "loading" | "ready" | "denied" | "error";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 12: the Employees ->
 * Invitations tab. Role selection is restricted to this organization's own roles (fetched from
 * `/api/organizations/roles`); the server independently re-validates the chosen role_id belongs to
 * this organization regardless of what this form sends.
 */
export function OrganizationInvitations({ organizationId }: { organizationId: string }) {
  const formId = useId();
  const [status, setStatus] = useState<Status>("loading");
  const [items, setItems] = useState<InvitationItem[]>([]);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [submitStatus, setSubmitStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function loadInvitations() {
    const body = await apiFetch<{ items: InvitationItem[] }>(`/api/organizations/invitations?organizationId=${organizationId}`);
    setItems(body.items);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadInvitations();
        if (cancelled) return;
        setStatus("ready");
        try {
          const rolesBody = await apiFetch<{ roles: RoleOption[] }>(`/api/organizations/roles?organizationId=${organizationId}`);
          if (!cancelled) setRoleOptions(rolesBody.roles.map((r) => ({ id: r.id, displayName: r.displayName })));
        } catch {
          // No roles.view — inviting still requires a role choice, so the form is hidden without it.
        }
      } catch (error) {
        if (cancelled) return;
        setStatus(error instanceof ApiError && error.httpStatus === 403 ? "denied" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  async function handleInvite(event: React.FormEvent) {
    event.preventDefault();
    setSubmitStatus("submitting");
    setSubmitError(null);
    try {
      await apiFetch("/api/organizations/invitations", { method: "POST", body: JSON.stringify({ organizationId, email, roleId }) });
      setEmail("");
      setRoleId("");
      setSubmitStatus("idle");
      await loadInvitations();
    } catch (error) {
      setSubmitStatus("error");
      setSubmitError(error instanceof ApiError ? error.message : "Could not send this invitation.");
    }
  }

  async function handleRevoke(invitationId: string) {
    setBusyId(invitationId);
    try {
      await apiFetch("/api/organizations/invitations/revoke", { method: "POST", body: JSON.stringify({ organizationId, invitationId }) });
      await loadInvitations();
    } finally {
      setBusyId(null);
    }
  }

  if (status === "loading") return <p role="status">Loading…</p>;
  if (status === "denied") {
    return (
      <p className="form-status form-status--error" role="alert">
        You don&apos;t have permission to view this organization&apos;s invitations.
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
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <div>
        <h2 style={{ marginTop: 0 }}>Invitations</h2>
        {items.length === 0 ? (
          <p>No pending invitations.</p>
        ) : (
          <ul style={{ display: "grid", gap: "0.75rem", padding: 0, margin: 0, listStyle: "none" }}>
            {items.map((item) => (
              <li key={item.id} className="early-access-form" style={{ padding: "1rem", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem" }}>
                <strong>{item.email}</strong>
                <span className="chip chip--neutral">Pending</span>
                <span style={{ fontSize: "0.8rem", color: "var(--ink-soft)" }}>Expires {new Date(item.expiresAt).toLocaleDateString()}</span>
                <button type="button" className="button button--ghost" disabled={busyId === item.id} onClick={() => void handleRevoke(item.id)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {roleOptions.length > 0 ? (
        <form className="early-access-form" onSubmit={(event) => void handleInvite(event)} aria-label="Invite a team member">
          <h3 style={{ marginTop: 0 }}>Invite a team member</h3>
          <div className="early-access-form__row">
            <div className="field">
              <label htmlFor={`${formId}-email`}>Email</label>
              <input id={`${formId}-email`} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`${formId}-role`}>Role</label>
              <select id={`${formId}-role`} required value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">Select a role…</option>
                {roleOptions.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {submitStatus === "error" && submitError ? (
            <p className="form-status form-status--error" role="alert">
              {submitError}
            </p>
          ) : null}
          <button type="submit" className="button button--primary" disabled={submitStatus === "submitting"}>
            {submitStatus === "submitting" ? "Sending…" : "Send invitation"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
