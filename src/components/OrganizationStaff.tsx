"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatDate } from "@/lib/ui/date";
import { DEFAULT_ROLE_CAPABILITIES, type StaffRole } from "@/lib/staff/capabilities";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  receivables_staff: "Receivables staff",
  accountant_viewer: "Accountant / Viewer",
  custom: "Custom role",
};

const ASSIGNABLE_ROLES = ["owner", "manager", "receivables_staff", "accountant_viewer", "custom"] as const;

interface StaffMember {
  id: string;
  userId: string;
  role: StaffRole;
  customRoleId: string | null;
  isAuthorizedRepresentative: boolean;
  createdAt: string;
}

interface CustomRole {
  id: string;
  name: string;
  permissions: string[];
}

type LoadState = "loading" | "ready" | "not_business" | "error";

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/** Mirrors StaffService.hasCapability exactly (owner -> always; custom -> own role's permissions; else -> DEFAULT_ROLE_CAPABILITIES) — this is presentation-only, every mutating route independently re-checks server-side. */
function hasCapability(member: StaffMember | undefined, customRoles: CustomRole[], capability: string): boolean {
  if (!member) return false;
  if (member.role === "owner") return true;
  if (member.role === "custom") {
    const role = customRoles.find((r) => r.id === member.customRoleId);
    return role ? role.permissions.includes(capability) : false;
  }
  return (DEFAULT_ROLE_CAPABILITIES[member.role] as readonly string[]).includes(capability);
}

export function OrganizationStaff() {
  const [state, setState] = useState<LoadState>("loading");
  const [businessProfileId, setBusinessProfileId] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);

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
      const [staffBody, rolesBody] = await Promise.all([
        apiFetch<{ staff: StaffMember[] }>(`/api/staff?businessProfileId=${active.businessProfileId}`),
        apiFetch<{ customRoles: CustomRole[] }>(`/api/staff/custom-roles?businessProfileId=${active.businessProfileId}`),
      ]);
      setStaff(staffBody.staff);
      setCustomRoles(rolesBody.customRoles);
      const self = staffBody.staff.find((s) => s.userId === me.id);
      setCanManage(hasCapability(self, rolesBody.customRoles, "manage_staff"));
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

  if (state === "loading") {
    return (
      <div className="card" aria-hidden="true">
        <div className="skeleton skeleton--line" style={{ width: "50%" }} />
        <div className="skeleton skeleton--line" style={{ width: "80%" }} />
      </div>
    );
  }

  if (state === "not_business") {
    return (
      <div className="empty-state">
        <h3>No business selected</h3>
        <p>Switch to a business profile from your account menu to manage its staff.</p>
      </div>
    );
  }

  if (state === "error" || !businessProfileId) {
    return (
      <div className="form-status form-status--error" role="alert">
        Something went wrong loading your staff. Please try again.
      </div>
    );
  }

  function roleLabel(member: StaffMember): string {
    if (member.role === "custom" && member.customRoleId) {
      return customRoles.find((r) => r.id === member.customRoleId)?.name ?? "Custom role";
    }
    return ROLE_LABEL[member.role] ?? member.role;
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <div className="card">
        <div className="card__header">
          <h2>Team members</h2>
          {canManage && (
            <button type="button" className="button button--primary" onClick={() => setInviteOpen(true)}>
              Invite staff
            </button>
          )}
        </div>

        {staff.length === 0 ? (
          <div className="empty-state">
            <h3>No staff yet</h3>
            <p>Invite team members to help manage this business.</p>
          </div>
        ) : (
          <div className="table-wrap table-wrap--responsive-cards">
            <table className="table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Authorized signer</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((member) => (
                  <tr key={member.id}>
                    <td data-label="Member">{shortId(member.userId)}</td>
                    <td data-label="Role">{roleLabel(member)}</td>
                    <td data-label="Authorized signer">{member.isAuthorizedRepresentative ? "Yes" : "No"}</td>
                    <td data-label="Since">{formatDate(member.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ marginTop: "0.75rem", color: "var(--ink-soft)", fontSize: "0.8rem" }}>
          <Link href="/organization/staff/roles">Manage custom roles</Link>
          {" · "}
          <Link href="/organization/approvals">Pending approvals</Link>
        </p>
      </div>

      {inviteOpen && canManage && businessProfileId && (
        <InviteStaffCard
          businessProfileId={businessProfileId}
          customRoles={customRoles}
          onDone={() => {
            setInviteOpen(false);
            void refresh();
          }}
          onCancel={() => setInviteOpen(false)}
        />
      )}
    </div>
  );
}

function InviteStaffCard({
  businessProfileId,
  customRoles,
  onDone,
  onCancel,
}: {
  businessProfileId: string;
  customRoles: CustomRole[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ASSIGNABLE_ROLES)[number]>("manager");
  const [customRoleId, setCustomRoleId] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await apiFetch("/api/staff/invite", {
        method: "POST",
        body: JSON.stringify({
          businessProfileId,
          email,
          role,
          ...(role === "custom" && customRoleId ? { customRoleId } : {}),
        }),
      });
      onDone();
    } catch {
      setErrorMessage("Couldn't send that invitation. Check the email and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <h2>Invite staff</h2>
      </div>
      <form onSubmit={(event) => void handleSubmit(event)} style={{ display: "grid", gap: "1rem" }}>
        <div className="field">
          <label htmlFor="invite-email">Email</label>
          <input id="invite-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
        </div>
        {role === "custom" && (
          <div className="field">
            <label htmlFor="invite-custom-role">Custom role</label>
            <select id="invite-custom-role" required value={customRoleId} onChange={(event) => setCustomRoleId(event.target.value)}>
              <option value="">Select a custom role…</option>
              {customRoles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        )}
        {errorMessage && <p className="field-error" role="alert">{errorMessage}</p>}
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button type="button" className="button button--ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="button button--primary" disabled={submitting}>
            {submitting ? "Sending…" : "Send invitation"}
          </button>
        </div>
      </form>
    </div>
  );
}
