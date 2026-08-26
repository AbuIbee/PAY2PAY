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
  upcomingPayments: unknown[];
  requests: ActionRequiredItem[];
  staffCount: number;
}

/**
 * Dashboard consistency fix (Product Owner UAT): Personal and Business previously rendered two
 * entirely different summary sections — different labels, different card counts, and (root cause)
 * Business's own summary silently vanished whenever GET /api/dashboard/business 403'd (see that
 * route's own doc comment). One shared shape, sourced from whichever dataset is active, so both
 * contexts render the identical five-card framework — same layout, only the underlying values
 * (and, for money, which field they come from) differ per context.
 */
interface DashboardSummary {
  moneyIOweMinorUnits: number;
  moneyOwedToMeMinorUnits: number;
  agreementsCount: number;
  upcomingPaymentsCount: number;
  actionRequiredCount: number;
}

function summaryFor(active: SelectableProfile | null, personalData: PersonalDashboardData | null, businessData: BusinessDashboardData | null): DashboardSummary | null {
  if (active?.kind === "personal" && personalData) {
    return {
      moneyIOweMinorUnits: personalData.moneyIOweMinorUnits,
      moneyOwedToMeMinorUnits: personalData.moneyOwedToMeMinorUnits,
      agreementsCount: personalData.agreements.length,
      upcomingPaymentsCount: personalData.upcomingPayments.length,
      actionRequiredCount: personalData.requests.length,
    };
  }
  if (active?.kind === "business" && businessData) {
    return {
      moneyIOweMinorUnits: businessData.payablesMinorUnits,
      moneyOwedToMeMinorUnits: businessData.receivablesMinorUnits,
      agreementsCount: businessData.agreements.length,
      upcomingPaymentsCount: businessData.upcomingPayments.length,
      actionRequiredCount: businessData.requests.length,
    };
  }
  return null;
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
          <p className="action-card__title">Payment Arrangements needing signature</p>
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
          <p className="action-card__title">My Cash</p>
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

  const summary = summaryFor(active, personalData, businessData);

  return (
    <div style={{ display: "grid", gap: "2rem" }}>
      {active && <OnboardingBanner kind={active.kind} />}

      <div className="hero__actions" style={{ alignItems: "flex-end" }}>
        <ProfileSwitcher profiles={profiles} activeKey={activeKeyFor(active)} onSwitch={(p) => void handleSwitch(p)} />
        <BusinessProfileForm onCreated={() => void loadAll()} />
      </div>

      {summary ? (
        <div className="card-grid">
          <div className="stat-card">
            <span className="stat-card__label">Money I owe</span>
            <span className="stat-card__value">{formatMoney(summary.moneyIOweMinorUnits)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Money owed to me</span>
            <span className="stat-card__value">{formatMoney(summary.moneyOwedToMeMinorUnits)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Payment Arrangements</span>
            <span className="stat-card__value">{summary.agreementsCount}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Upcoming payments</span>
            <span className="stat-card__value">{summary.upcomingPaymentsCount}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Action required</span>
            <span className="stat-card__value">{summary.actionRequiredCount}</span>
          </div>
        </div>
      ) : null}

      {active?.kind === "business" && businessData && (
        <p style={{ margin: 0 }}>
          {/* Organization Features: Coming Soon treatment — Manage Staff is not yet reachable (see
              /organization/staff's own doc comment for the root cause); plain text, not a link, so
              this never behaves like a working control. */}
          Manage staff <span className="chip chip--neutral">Coming Soon</span> for {active.displayName} ({businessData.staffCount}{" "}
          {businessData.staffCount === 1 ? "member" : "members"}, {businessData.customers.length}{" "}
          {businessData.customers.length === 1 ? "customer" : "customers"}).
        </p>
      )}

      <div>
        <h2 style={{ margin: "0 0 1rem", fontSize: "1.1rem" }}>What requires action</h2>
        <ActionCards
          unreadNotifications={unreadNotifications}
          requests={active?.kind === "personal" ? (personalData?.requests ?? null) : (businessData?.requests ?? null)}
        />
      </div>
    </div>
  );
}
