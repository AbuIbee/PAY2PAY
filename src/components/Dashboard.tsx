"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BusinessProfileForm } from "./BusinessProfileForm";
import { OnboardingBanner } from "./OnboardingBanner";
import { ProfileSwitcher, type SelectableProfile } from "./ProfileSwitcher";
import { formatMoney } from "@/lib/ui/money";

interface ActionRequiredItem {
  agreementId: string | null;
  reason: "awaiting_your_acknowledgment" | "awaiting_your_decision" | "awaiting_your_signature" | "pending_connection_invitation";
  invitationId?: string;
}

interface PersonalDashboardData {
  moneyIOweMinorUnits: number;
  moneyOwedToMeMinorUnits: number;
  agreements: unknown[];
  upcomingPayments: unknown[];
  requests: ActionRequiredItem[];
}

interface BusinessDashboardData {
  receivablesMinorUnits: number;
  payablesMinorUnits: number;
  agreements: unknown[];
  customers: unknown[];
  staffCount: number;
}

type LoadStatus = "loading" | "ready" | "unauthorized" | "error";

function activeKeyFor(profile: SelectableProfile | null): string {
  if (!profile) return "personal";
  return profile.kind === "personal" ? "personal" : `business:${profile.businessProfileId}`;
}

/**
 * Sprint 18B: "What requires action?" deep-links — always real routes built
 * elsewhere in this sprint, never placeholders. The unread-notification
 * count is fetched separately so this card can say "3 unread" rather than
 * just "Notifications".
 *
 * Section M (closed-beta remediation, Product Owner review): "Pending invitations" and "Agreements
 * needing signature" previously showed static copy with no real count, even though
 * /api/dashboard/personal already computes exactly this via `requests` (this session's A1 fix added
 * the `pending_connection_invitation` reason to that same array) — this card just wasn't reading it.
 * `requests` is null for a business-acting-as user (no equivalent field on BusinessDashboardData yet),
 * in which case these two cards fall back to their original generic copy rather than claiming a count
 * they can't back up. "Payments" copy no longer claims a failed/retry-specific filter that
 * PaymentsList.tsx doesn't actually implement (it's a flat, unfiltered list) — audit finding.
 */
function ActionCards({
  unreadNotifications,
  requests,
}: {
  unreadNotifications: number | null;
  requests: ActionRequiredItem[] | null;
}) {
  const pendingInvitations = requests?.filter((r) => r.reason === "pending_connection_invitation").length ?? null;
  const needingSignature = requests?.filter((r) => r.reason === "awaiting_your_signature").length ?? null;

  return (
    <div className="card-grid">
      <Link href="/connections/invitations" className="action-card">
        <div>
          <p className="action-card__title">Pending invitations</p>
          <p className="action-card__detail">
            {pendingInvitations === null
              ? "Review connections waiting on your acceptance"
              : pendingInvitations > 0
                ? `${pendingInvitations} waiting on your response`
                : "No pending invitations"}
          </p>
        </div>
        <span className="action-card__arrow" aria-hidden="true">→</span>
      </Link>
      <Link href="/agreements" className="action-card">
        <div>
          <p className="action-card__title">Agreements needing signature</p>
          <p className="action-card__detail">
            {needingSignature === null
              ? "Review and sign agreements awaiting you"
              : needingSignature > 0
                ? `${needingSignature} awaiting your signature`
                : "Nothing awaiting your signature"}
          </p>
        </div>
        <span className="action-card__arrow" aria-hidden="true">→</span>
      </Link>
      <Link href="/payment-methods" className="action-card">
        <div>
          <p className="action-card__title">Payment methods</p>
          <p className="action-card__detail">Add or verify a bank account or card</p>
        </div>
        <span className="action-card__arrow" aria-hidden="true">→</span>
      </Link>
      <Link href="/payments" className="action-card">
        <div>
          <p className="action-card__title">Payments</p>
          <p className="action-card__detail">View your payment history and status</p>
        </div>
        <span className="action-card__arrow" aria-hidden="true">→</span>
      </Link>
      <Link href="/notifications" className="action-card">
        <div>
          <p className="action-card__title">Notifications</p>
          <p className="action-card__detail">
            {unreadNotifications === null ? "View updates" : unreadNotifications > 0 ? `${unreadNotifications} unread` : "You're all caught up"}
          </p>
        </div>
        <span className="action-card__arrow" aria-hidden="true">→</span>
      </Link>
      <Link href="/support" className="action-card">
        <div>
          <p className="action-card__title">Support &amp; appeals</p>
          <p className="action-card__detail">Open cases, disputes, and appeal status</p>
        </div>
        <span className="action-card__arrow" aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

export function Dashboard() {
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [profiles, setProfiles] = useState<SelectableProfile[]>([]);
  const [active, setActive] = useState<SelectableProfile | null>(null);
  const [personalData, setPersonalData] = useState<PersonalDashboardData | null>(null);
  const [businessData, setBusinessData] = useState<BusinessDashboardData | null>(null);
  const [unreadNotifications, setUnreadNotifications] = useState<number | null>(null);

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

    fetch("/api/notifications")
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { notifications: Array<{ readAt: string | null }> };
        setUnreadNotifications(body.notifications.filter((n) => n.readAt === null).length);
      })
      .catch(() => setUnreadNotifications(null));
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
    <div style={{ display: "grid", gap: "2rem" }}>
      {active && <OnboardingBanner kind={active.kind} />}

      <div className="hero__actions" style={{ alignItems: "flex-end" }}>
        <ProfileSwitcher profiles={profiles} activeKey={activeKeyFor(active)} onSwitch={(p) => void handleSwitch(p)} />
        <BusinessProfileForm onCreated={() => void loadAll()} />
      </div>

      {active?.kind === "personal" && personalData ? (
        <div className="card-grid">
          <div className="stat-card">
            <span className="stat-card__label">Money I owe</span>
            <span className="stat-card__value">{formatMoney(personalData.moneyIOweMinorUnits)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Money owed to me</span>
            <span className="stat-card__value">{formatMoney(personalData.moneyOwedToMeMinorUnits)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Agreements</span>
            <span className="stat-card__value">{personalData.agreements.length}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Upcoming payments</span>
            <span className="stat-card__value">{personalData.upcomingPayments.length}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Action required</span>
            <span className="stat-card__value">{personalData.requests.length}</span>
          </div>
        </div>
      ) : null}

      {active?.kind === "business" && businessData ? (
        <div className="card-grid">
          <div className="stat-card">
            <span className="stat-card__label">Receivables</span>
            <span className="stat-card__value">{formatMoney(businessData.receivablesMinorUnits)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Payables</span>
            <span className="stat-card__value">{formatMoney(businessData.payablesMinorUnits)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Agreements</span>
            <span className="stat-card__value">{businessData.agreements.length}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Customers</span>
            <span className="stat-card__value">{businessData.customers.length}</span>
          </div>
        </div>
      ) : null}

      {active?.kind === "business" && businessData && (
        <p style={{ margin: 0 }}>
          <Link href="/organization/staff">Manage staff</Link> for {active.displayName} ({businessData.staffCount}{" "}
          {businessData.staffCount === 1 ? "member" : "members"}).
        </p>
      )}

      <div>
        <h2 style={{ margin: "0 0 1rem", fontSize: "1.1rem" }}>What requires action</h2>
        <ActionCards unreadNotifications={unreadNotifications} requests={active?.kind === "personal" ? personalData?.requests ?? null : null} />
      </div>
    </div>
  );
}
