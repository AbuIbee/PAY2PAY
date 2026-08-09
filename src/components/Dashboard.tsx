"use client";

import { useCallback, useEffect, useState } from "react";
import { BusinessProfileForm } from "./BusinessProfileForm";
import { ProfileSwitcher, type SelectableProfile } from "./ProfileSwitcher";

interface PersonalDashboardData {
  moneyIOweMinorUnits: number;
  moneyOwedToMeMinorUnits: number;
  agreements: unknown[];
  upcomingPayments: unknown[];
  requests: unknown[];
}

interface BusinessDashboardData {
  receivablesMinorUnits: number;
  payablesMinorUnits: number;
  agreements: unknown[];
  customers: unknown[];
  staffPlaceholder: boolean;
  reportsPlaceholder: boolean;
}

type LoadStatus = "loading" | "ready" | "unauthorized" | "error";

function activeKeyFor(profile: SelectableProfile | null): string {
  if (!profile) return "personal";
  return profile.kind === "personal" ? "personal" : `business:${profile.businessProfileId}`;
}

export function Dashboard() {
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [profiles, setProfiles] = useState<SelectableProfile[]>([]);
  const [active, setActive] = useState<SelectableProfile | null>(null);
  const [personalData, setPersonalData] = useState<PersonalDashboardData | null>(null);
  const [businessData, setBusinessData] = useState<BusinessDashboardData | null>(null);

  const loadAll = useCallback(async () => {
    const [profilesResponse, activeResponse] = await Promise.all([
      fetch("/api/profiles"),
      fetch("/api/profiles/active"),
    ]);
    if (profilesResponse.status === 401 || activeResponse.status === 401) {
      setLoadStatus("unauthorized");
      return;
    }
    if (!profilesResponse.ok || !activeResponse.ok) {
      setLoadStatus("error");
      return;
    }
    const profilesBody = (await profilesResponse.json()) as { profiles: SelectableProfile[] };
    const activeBody = (await activeResponse.json()) as SelectableProfile;
    setProfiles(profilesBody.profiles);
    setActive(activeBody);

    if (activeBody.kind === "personal") {
      const response = await fetch("/api/dashboard/personal");
      if (response.ok) setPersonalData((await response.json()) as PersonalDashboardData);
    } else {
      const response = await fetch(`/api/dashboard/business?businessProfileId=${activeBody.businessProfileId}`);
      if (response.ok) setBusinessData((await response.json()) as BusinessDashboardData);
    }
    setLoadStatus("ready");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadAll();
      } catch {
        if (!cancelled) setLoadStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  async function handleSwitch(profile: SelectableProfile) {
    const body =
      profile.kind === "personal" ? { kind: "personal" } : { kind: "business", businessProfileId: profile.businessProfileId };
    setLoadStatus("loading");
    await fetch("/api/profiles/active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await loadAll();
  }

  if (loadStatus === "loading") return <p role="status">Loading dashboard…</p>;

  if (loadStatus === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        You need to <a href="/login">sign in</a> to view your dashboard.
      </p>
    );
  }

  if (loadStatus === "error") {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        Something went wrong loading your dashboard. Please try again.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem" }}>
      <div className="hero__actions" style={{ alignItems: "flex-end" }}>
        <ProfileSwitcher profiles={profiles} activeKey={activeKeyFor(active)} onSwitch={(p) => void handleSwitch(p)} />
        <BusinessProfileForm onCreated={() => void loadAll()} />
      </div>

      {active?.kind === "personal" && personalData ? (
        <div className="early-access-form">
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Personal</h2>
          <p style={{ margin: 0 }}>Money I owe: ${(personalData.moneyIOweMinorUnits / 100).toFixed(2)}</p>
          <p style={{ margin: 0 }}>Money owed to me: ${(personalData.moneyOwedToMeMinorUnits / 100).toFixed(2)}</p>
          <p style={{ margin: 0 }}>Agreements: {personalData.agreements.length}</p>
          <p style={{ margin: 0 }}>Upcoming payments: {personalData.upcomingPayments.length}</p>
          <p style={{ margin: 0 }}>Requests: {personalData.requests.length}</p>
        </div>
      ) : null}

      {active?.kind === "business" && businessData ? (
        <div className="early-access-form">
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{active.displayName}</h2>
          <p style={{ margin: 0 }}>Receivables: ${(businessData.receivablesMinorUnits / 100).toFixed(2)}</p>
          <p style={{ margin: 0 }}>Payables: ${(businessData.payablesMinorUnits / 100).toFixed(2)}</p>
          <p style={{ margin: 0 }}>Agreements: {businessData.agreements.length}</p>
          <p style={{ margin: 0 }}>Customers: {businessData.customers.length}</p>
          <p style={{ margin: 0, color: "var(--ink-soft)" }}>Staff — coming in a later phase</p>
          <p style={{ margin: 0, color: "var(--ink-soft)" }}>Reports — coming in a later phase</p>
        </div>
      ) : null}
    </div>
  );
}
