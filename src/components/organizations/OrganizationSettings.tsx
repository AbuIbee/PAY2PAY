"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { formatMoney } from "@/lib/ui/money";

interface SettingsResponse {
  organizationId: string;
  legalBusinessName: string;
  displayName: string;
  dbaName: string | null;
  entityType: string;
  industry: string | null;
  formationJurisdiction: string | null;
  businessEmail: string | null;
  website: string | null;
  status: string;
  plan: { code: string; name: string; monthlyFeeMinorUnits: number | null } | null;
}

type Status = "loading" | "ready" | "denied" | "error";

export function OrganizationSettings({ organizationId }: { organizationId: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [data, setData] = useState<SettingsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<SettingsResponse>(`/api/organizations/settings?organizationId=${organizationId}`);
        if (!cancelled) {
          setData(body);
          setStatus("ready");
        }
      } catch (error) {
        if (cancelled) return;
        setStatus(error instanceof ApiError && error.httpStatus === 403 ? "denied" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  if (status === "loading") return <p role="status">Loading…</p>;
  if (status === "denied") {
    return (
      <p className="form-status form-status--error" role="alert">
        You don&apos;t have permission to view this organization&apos;s settings.
      </p>
    );
  }
  if (status === "error" || !data) {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong. Please try again.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1rem", maxWidth: "32rem" }}>
      <h2 style={{ margin: 0 }}>Organization Settings</h2>
      <dl style={{ display: "grid", gap: "0.5rem", margin: 0 }}>
        <div>
          <dt style={{ fontWeight: 600 }}>Legal business name</dt>
          <dd style={{ margin: 0 }}>{data.legalBusinessName}</dd>
        </div>
        <div>
          <dt style={{ fontWeight: 600 }}>Display name</dt>
          <dd style={{ margin: 0 }}>{data.displayName}</dd>
        </div>
        {data.dbaName ? (
          <div>
            <dt style={{ fontWeight: 600 }}>DBA/trade name</dt>
            <dd style={{ margin: 0 }}>{data.dbaName}</dd>
          </div>
        ) : null}
        <div>
          <dt style={{ fontWeight: 600 }}>Entity type</dt>
          <dd style={{ margin: 0 }}>{data.entityType}</dd>
        </div>
        {data.industry ? (
          <div>
            <dt style={{ fontWeight: 600 }}>Industry</dt>
            <dd style={{ margin: 0 }}>{data.industry}</dd>
          </div>
        ) : null}
        {data.formationJurisdiction ? (
          <div>
            <dt style={{ fontWeight: 600 }}>Formation jurisdiction</dt>
            <dd style={{ margin: 0 }}>{data.formationJurisdiction}</dd>
          </div>
        ) : null}
        {data.businessEmail ? (
          <div>
            <dt style={{ fontWeight: 600 }}>Business email</dt>
            <dd style={{ margin: 0 }}>{data.businessEmail}</dd>
          </div>
        ) : null}
        {data.website ? (
          <div>
            <dt style={{ fontWeight: 600 }}>Website</dt>
            <dd style={{ margin: 0 }}>{data.website}</dd>
          </div>
        ) : null}
        <div>
          <dt style={{ fontWeight: 600 }}>Status</dt>
          <dd style={{ margin: 0 }}>{data.status}</dd>
        </div>
      </dl>

      <div>
        <h3>Subscription</h3>
        {data.plan ? (
          <p>
            {data.plan.name}
            {data.plan.monthlyFeeMinorUnits !== null ? ` — ${formatMoney(data.plan.monthlyFeeMinorUnits)}/month` : ""}
          </p>
        ) : (
          <p>No active Paid2You subscription.</p>
        )}
        <a className="button button--secondary" href={`/organizations/${data.organizationId}/settings/billing`}>
          Billing &amp; Subscription
        </a>
      </div>
    </div>
  );
}
