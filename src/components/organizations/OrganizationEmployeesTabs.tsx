"use client";

import { useState } from "react";
import { OrganizationEmployees } from "./OrganizationEmployees";
import { OrganizationInvitations } from "./OrganizationInvitations";
import { OrganizationRolesPermissions } from "./OrganizationRolesPermissions";

type Tab = "members" | "invitations" | "roles";

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: "members", label: "Team Members" },
  { key: "invitations", label: "Invitations" },
  { key: "roles", label: "Roles & Permissions" },
];

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Custom RBAC Runtime Cutover, Step 10: the Employees
 * page shell — Team Members / Invitations / Roles & Permissions, using this codebase's existing
 * design system (same tab/button classes as the rest of the app, no separate shell). Each tab's own
 * component independently re-checks its own permission server-side; switching tabs never grants
 * access the server would otherwise deny.
 */
export function OrganizationEmployeesTabs({ organizationId }: { organizationId: string }) {
  const [tab, setTab] = useState<Tab>("members");

  return (
    <div>
      <h1>Employees</h1>
      <div role="tablist" aria-label="Employees" style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem", borderBottom: "1px solid var(--border, #ddd)" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`button ${tab === t.key ? "button--primary" : "button--ghost"}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "members" && <OrganizationEmployees organizationId={organizationId} />}
        {tab === "invitations" && <OrganizationInvitations organizationId={organizationId} />}
        {tab === "roles" && <OrganizationRolesPermissions organizationId={organizationId} />}
      </div>
    </div>
  );
}
