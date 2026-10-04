"use client";

import { useEffect, useId, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";

interface CatalogEntry {
  key: string;
  category: string;
  label: string;
  description: string;
}

interface RolePermission {
  permissionKey: string;
  scope: string;
}

interface RoleItem {
  id: string;
  displayName: string;
  description: string | null;
  isOwnerRole: boolean;
  isProtected: boolean;
  memberCount: number;
  permissions: RolePermission[];
}

type Status = "loading" | "ready" | "denied" | "error";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 13/14/15/16/18: the
 * Employees -> Roles & Permissions tab. Every permission label/description is read directly from the
 * server's own catalog (`PERMISSION_CATALOG`, via GET /api/organizations/roles) — never duplicated as
 * a second copy of permission text in this component. A protected role's own permission checkboxes
 * are rendered read-only (its permissions cannot be edited individually — see
 * OrganizationRoleService.assignPermission's own invariant) but its display name remains renamable.
 */
export function OrganizationRolesPermissions({ organizationId }: { organizationId: string }) {
  const formId = useId();
  const [status, setStatus] = useState<Status>("loading");
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [newRoleName, setNewRoleName] = useState("");
  const [createStatus, setCreateStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null);

  async function load() {
    const body = await apiFetch<{ roles: RoleItem[]; catalog: CatalogEntry[] }>(`/api/organizations/roles?organizationId=${organizationId}`);
    setRoles(body.roles);
    setCatalog(body.catalog);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await load();
        if (!cancelled) setStatus("ready");
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

  async function handleCreateRole(event: React.FormEvent) {
    event.preventDefault();
    setCreateStatus("submitting");
    setCreateError(null);
    try {
      await apiFetch("/api/organizations/roles", { method: "POST", body: JSON.stringify({ organizationId, displayName: newRoleName, permissions: [] }) });
      setNewRoleName("");
      setCreateStatus("idle");
      await load();
    } catch (error) {
      setCreateStatus("error");
      setCreateError(error instanceof ApiError ? error.message : "Could not create this role.");
    }
  }

  async function handleRename(roleId: string, displayName: string) {
    setActionError(null);
    try {
      await apiFetch("/api/organizations/roles", { method: "PATCH", body: JSON.stringify({ organizationId, roleId, displayName }) });
      await load();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Could not rename this role.");
    }
  }

  async function handleTogglePermission(role: RoleItem, permissionKey: string, enabled: boolean) {
    setActionError(null);
    try {
      if (enabled) {
        await apiFetch("/api/organizations/roles/permissions", { method: "POST", body: JSON.stringify({ organizationId, roleId: role.id, permissionKey, scope: "organization" }) });
      } else {
        await apiFetch("/api/organizations/roles/permissions", { method: "DELETE", body: JSON.stringify({ organizationId, roleId: role.id, permissionKey }) });
      }
      await load();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Could not update this role's permissions.");
    }
  }

  async function handleDelete(roleId: string) {
    setActionError(null);
    try {
      await apiFetch("/api/organizations/roles", { method: "DELETE", body: JSON.stringify({ organizationId, roleId }) });
      await load();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Could not delete this role — it may still have members or pending invitations assigned.");
    }
  }

  if (status === "loading") return <p role="status">Loading…</p>;
  if (status === "denied") {
    return (
      <p className="form-status form-status--error" role="alert">
        You don&apos;t have permission to view this organization&apos;s roles and permissions.
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

  const categories = [...new Set(catalog.map((c) => c.category))];

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <h2 style={{ marginTop: 0 }}>Roles &amp; Permissions</h2>
      {actionError ? (
        <p className="form-status form-status--error" role="alert">
          {actionError}
        </p>
      ) : null}

      <ul style={{ display: "grid", gap: "1rem", padding: 0, margin: 0, listStyle: "none" }}>
        {roles.map((role) => {
          const granted = new Set(role.permissions.map((p) => p.permissionKey));
          const expanded = expandedRoleId === role.id;
          return (
            <li key={role.id} className="early-access-form" style={{ padding: "1rem" }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem" }}>
                <input
                  aria-label={`Rename ${role.displayName}`}
                  defaultValue={role.displayName}
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value !== role.displayName) void handleRename(role.id, e.target.value.trim());
                  }}
                  style={{ fontWeight: 700 }}
                />
                {role.isOwnerRole ? <span className="chip chip--success">Owner (protected)</span> : null}
                <span className="chip chip--neutral">
                  {role.memberCount} member{role.memberCount === 1 ? "" : "s"}
                </span>
                <button type="button" className="button button--ghost" onClick={() => setExpandedRoleId(expanded ? null : role.id)}>
                  {expanded ? "Hide permissions" : "Edit permissions"}
                </button>
                {!role.isProtected ? (
                  <button type="button" className="button button--ghost" onClick={() => void handleDelete(role.id)}>
                    Delete
                  </button>
                ) : null}
              </div>
              {role.description ? <p style={{ fontSize: "0.85rem", color: "var(--ink-soft)" }}>{role.description}</p> : null}

              {expanded ? (
                <div style={{ display: "grid", gap: "1rem", marginTop: "1rem" }}>
                  {categories.map((category) => (
                    <fieldset key={category} style={{ border: "none", padding: 0, margin: 0 }}>
                      <legend style={{ fontWeight: 600 }}>{category}</legend>
                      {catalog
                        .filter((entry) => entry.category === category)
                        .map((entry) => (
                          <div key={entry.key} className="checkbox-field">
                            <input
                              id={`${formId}-${role.id}-${entry.key}`}
                              type="checkbox"
                              checked={granted.has(entry.key)}
                              disabled={role.isProtected}
                              onChange={(e) => void handleTogglePermission(role, entry.key, e.target.checked)}
                            />
                            <label htmlFor={`${formId}-${role.id}-${entry.key}`}>
                              {entry.label}
                              <br />
                              <small style={{ color: "var(--ink-soft)" }}>{entry.description}</small>
                            </label>
                          </div>
                        ))}
                    </fieldset>
                  ))}
                  {role.isProtected ? <p><small>This role&apos;s permissions are protected and cannot be edited individually.</small></p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <form className="early-access-form" onSubmit={(event) => void handleCreateRole(event)} aria-label="Create a role">
        <h3 style={{ marginTop: 0 }}>Create a role</h3>
        <div className="field">
          <label htmlFor={`${formId}-new-role-name`}>Role name</label>
          <input id={`${formId}-new-role-name`} required value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} />
        </div>
        {createStatus === "error" && createError ? (
          <p className="form-status form-status--error" role="alert">
            {createError}
          </p>
        ) : null}
        <button type="submit" className="button button--primary" disabled={createStatus === "submitting"}>
          {createStatus === "submitting" ? "Creating…" : "Create role"}
        </button>
      </form>
    </div>
  );
}
