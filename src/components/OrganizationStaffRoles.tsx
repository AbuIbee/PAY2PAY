"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { businessCapabilityLabel } from "@/lib/ui/statusLabels";
import { CAPABILITIES } from "@/lib/staff/capabilities";
import { StepUpChallenge } from "@/components/StepUpChallenge";
import { useStepUpGuardedAction } from "@/lib/ui/useStepUpGuardedAction";

interface CustomRole {
  id: string;
  name: string;
  permissions: string[];
}

type LoadState = "loading" | "ready" | "not_business" | "error";

export function OrganizationStaffRoles() {
  const [state, setState] = useState<LoadState>("loading");
  const [businessProfileId, setBusinessProfileId] = useState<string | null>(null);
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    try {
      const active = await apiFetch<{ kind: string; businessProfileId?: string }>("/api/profiles/active");
      if (active.kind !== "business" || !active.businessProfileId) {
        setState("not_business");
        return;
      }
      setBusinessProfileId(active.businessProfileId);
      const body = await apiFetch<{ customRoles: CustomRole[] }>(`/api/staff/custom-roles?businessProfileId=${active.businessProfileId}`);
      setRoles(body.customRoles);
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
    return <div className="skeleton skeleton--card" aria-hidden="true" />;
  }
  if (state === "not_business") {
    return (
      <div className="empty-state">
        <h3>No business selected</h3>
        <p>Switch to a business profile to manage custom roles.</p>
      </div>
    );
  }
  if (state === "error" || !businessProfileId) {
    return (
      <div className="form-status form-status--error" role="alert">
        Something went wrong loading custom roles. Please try again.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      {roles.length === 0 ? (
        <div className="empty-state">
          <h3>No custom roles yet</h3>
          <p>Create one to grant a specific set of capabilities to staff who don&apos;t fit the standard roles.</p>
        </div>
      ) : (
        roles.map((role) => (
          <div key={role.id} className="card">
            <div className="card__header">
              <h2>{role.name}</h2>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {role.permissions.map((permission) => (
                <span key={permission} className="chip chip--neutral">
                  {businessCapabilityLabel[permission] ?? permission}
                </span>
              ))}
            </div>
          </div>
        ))
      )}

      {!creating ? (
        <button type="button" className="button button--primary" style={{ justifySelf: "start" }} onClick={() => setCreating(true)}>
          Create custom role
        </button>
      ) : (
        <CreateRoleCard
          businessProfileId={businessProfileId}
          onDone={() => {
            setCreating(false);
            void refresh();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function CreateRoleCard({ businessProfileId, onDone, onCancel }: { businessProfileId: string; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { run, isChallengeOpen, resolveChallenge, cancelChallenge } = useStepUpGuardedAction(async () => {
    return apiFetch("/api/staff/custom-roles", {
      method: "POST",
      body: JSON.stringify({ businessProfileId, name, permissions }),
    });
  });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    try {
      await run();
      onDone();
    } catch {
      setErrorMessage("Couldn't create that role. Please try again.");
    }
  }

  function toggle(permission: string) {
    setPermissions((current) => (current.includes(permission) ? current.filter((p) => p !== permission) : [...current, permission]));
  }

  return (
    <div className="card">
      <div className="card__header">
        <h2>New custom role</h2>
      </div>
      <form onSubmit={(event) => void handleSubmit(event)} style={{ display: "grid", gap: "1rem" }}>
        <div className="field">
          <label htmlFor="role-name">Role name</label>
          <input id="role-name" required value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
          <legend style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: "0.5rem" }}>Capabilities</legend>
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {CAPABILITIES.map((capability) => (
              <label key={capability} className="checkbox-field">
                <input type="checkbox" checked={permissions.includes(capability)} onChange={() => toggle(capability)} />
                {businessCapabilityLabel[capability] ?? capability}
              </label>
            ))}
          </div>
        </fieldset>
        {errorMessage && <p className="field-error" role="alert">{errorMessage}</p>}
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button type="button" className="button button--ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="button button--primary" disabled={permissions.length === 0 || !name}>
            Create role
          </button>
        </div>
      </form>

      {isChallengeOpen && (
        <StepUpChallenge
          action="create_custom_role"
          actionDescription="create this custom role"
          onVerified={resolveChallenge}
          onCancel={cancelChallenge}
        />
      )}
    </div>
  );
}
