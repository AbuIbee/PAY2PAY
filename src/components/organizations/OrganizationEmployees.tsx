"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";

interface EmployeeItem {
  id: string;
  userId: string;
  email: string | null;
  roleId: string | null;
  roleName: string;
  isOwnerRole: boolean;
  isAuthorizedRepresentative: boolean;
  memberSince: string;
}

interface RoleOption {
  id: string;
  displayName: string;
}

type Status = "loading" | "ready" | "denied" | "error";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 10/11: the Employees
 * -> Team Members tab. Role-change/remove controls are rendered whenever the role list loaded (a
 * reasonable UX signal — `roles.view` is typically paired with `roles.assign`/`members.remove` in the
 * default templates) but that is never the authorization: both actions re-check the real permission
 * server-side (`/api/organizations/members`, via `OrganizationPermissionService`/
 * `OrganizationAuditedMutations`) and the controls simply show the server's own error on a denied
 * attempt rather than disappearing — "UI hiding is not authorization."
 */
export function OrganizationEmployees({ organizationId }: { organizationId: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [items, setItems] = useState<EmployeeItem[]>([]);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const body = await apiFetch<{ items: EmployeeItem[] }>(`/api/organizations/employees?organizationId=${organizationId}`);
    setItems(body.items);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await load();
        if (cancelled) return;
        setStatus("ready");
        try {
          const rolesBody = await apiFetch<{ roles: RoleOption[] }>(`/api/organizations/roles?organizationId=${organizationId}`);
          if (!cancelled) setRoleOptions(rolesBody.roles.map((r) => ({ id: r.id, displayName: r.displayName })));
        } catch {
          // No roles.view — mutation controls simply won't render; the list itself still does.
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

  async function handleRoleChange(memberId: string, roleId: string) {
    setBusyId(memberId);
    setActionError(null);
    try {
      await apiFetch("/api/organizations/members", { method: "PATCH", body: JSON.stringify({ organizationId, memberId, roleId }) });
      await load();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Could not change this member's role.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(memberId: string) {
    setBusyId(memberId);
    setActionError(null);
    try {
      await apiFetch("/api/organizations/members", { method: "DELETE", body: JSON.stringify({ organizationId, memberId }) });
      await load();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Could not remove this member.");
    } finally {
      setBusyId(null);
    }
  }

  if (status === "loading") return <p role="status">Loading…</p>;
  if (status === "denied") {
    return (
      <p className="form-status form-status--error" role="alert">
        You don&apos;t have permission to view this organization&apos;s team members.
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
      <h2 style={{ marginTop: 0 }}>Team Members</h2>
      {actionError ? (
        <p className="form-status form-status--error" role="alert">
          {actionError}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p>No team members yet.</p>
      ) : (
        <ul style={{ display: "grid", gap: "0.75rem", padding: 0, margin: 0, listStyle: "none" }}>
          {items.map((item) => (
            <li key={item.id} className="early-access-form" style={{ padding: "1rem", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem" }}>
              <strong>{item.email ?? "Unknown"}</strong>
              <span className="chip chip--info">{item.roleName}</span>
              {item.isAuthorizedRepresentative ? <span className="chip chip--neutral">Authorized representative</span> : null}
              {roleOptions.length > 0 ? (
                <select
                  aria-label={`Change role for ${item.email ?? "this member"}`}
                  value={item.roleId ?? ""}
                  disabled={busyId === item.id}
                  onChange={(event) => void handleRoleChange(item.id, event.target.value)}
                >
                  {!item.roleId ? <option value="">Select a role…</option> : null}
                  {roleOptions.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.displayName}
                    </option>
                  ))}
                </select>
              ) : null}
              {roleOptions.length > 0 ? (
                <button type="button" className="button button--ghost" disabled={busyId === item.id} onClick={() => void handleRemove(item.id)}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
