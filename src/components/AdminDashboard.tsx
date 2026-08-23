"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface AuditEventSummary {
  id: number;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  occurredAt: string;
  targetResourceType: string | null;
  targetResourceId: string | null;
  reason: string | null;
}

interface EnvironmentStatus {
  appEnv: string;
  nodeEnv: string;
  database: "configured" | "not_configured";
  documentStorage: "configured" | "not_configured";
  paymentProvider: string;
  paymentProviderEnvironment: "sandbox" | "production";
  kycProvider: string;
  kycProviderEnvironment: "sandbox" | "production";
  emailDelivery: "console_log_only";
  smsDelivery: "console_log_only";
  scheduledJobs: "configured" | "not_configured";
}

interface OverviewData {
  totalUsers: number;
  activeUsers: number;
  suspendedUsers: number;
  testAccounts: number;
  personalProfileCount: number;
  businessProfileCount: number;
  agreementCountsByStatus: Record<string, number>;
  signatureEventCount: number;
  agreementPdfCount: number;
  recentAuditEvents: AuditEventSummary[];
  recentAdminActions: AuditEventSummary[];
  environmentStatus: EnvironmentStatus;
}

function formatStatusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

type LoadStatus = "loading" | "ready" | "unauthorized" | "forbidden" | "error";

/** Sprint 6A admin dashboard — every number here comes directly from AdminService.getDashboardOverview's real DB counts, never a fabricated placeholder. */
export function AdminDashboard() {
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/overview")
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 401) return setLoadStatus("unauthorized");
        if (response.status === 403) return setLoadStatus("forbidden");
        if (!response.ok) return setLoadStatus("error");
        setData((await response.json()) as OverviewData);
        setLoadStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setLoadStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadStatus === "loading") return <p role="status">Loading dashboard…</p>;
  if (loadStatus === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert">
        You need to <a href="/login">sign in</a> to view the admin console.
      </p>
    );
  }
  if (loadStatus === "forbidden") {
    return (
      <p className="form-status form-status--error" role="alert">
        You do not have administrative access.
      </p>
    );
  }
  if (loadStatus === "error" || !data) {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading the dashboard. Please try again.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "48rem" }}>
      {/*
        SPRINT_20_ClosedBetaReadiness: this page previously had zero links to any of its ten real
        admin sub-pages (users, businesses, ledger, audit, appeals, support, restrictions,
        retention-holds, notifications, risk/fraud) — every one is a real, working route, reachable
        only by typing its exact URL. This is the fix: a real navigation surface, not a placeholder.
      */}
      <nav className="early-access-form" aria-label="Admin tools">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Admin tools</h2>
        <ul style={{ margin: "0.5rem 0 0", padding: 0, listStyle: "none", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {[
            { href: "/admin/users", label: "Users" },
            { href: "/admin/businesses", label: "Businesses" },
            { href: "/admin/ledger", label: "Ledger" },
            { href: "/admin/audit", label: "Audit log" },
            { href: "/admin/risk-events", label: "Risk & fraud signals" },
            { href: "/admin/appeals", label: "Appeals" },
            { href: "/admin/support", label: "Support" },
            { href: "/admin/restrictions", label: "Restrictions" },
            { href: "/admin/retention-holds", label: "Retention holds" },
            { href: "/admin/notifications", label: "Notification delivery" },
          ].map((item) => (
            <li key={item.href}>
              <Link href={item.href} className="button button--ghost">
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="early-access-form__row">
        <div className="early-access-form">
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Users</h2>
          <p style={{ margin: 0 }}>Total: {data.totalUsers}</p>
          <p style={{ margin: 0 }}>Active: {data.activeUsers}</p>
          <p style={{ margin: 0 }}>Suspended: {data.suspendedUsers}</p>
          <p style={{ margin: 0 }}>Test/internal: {data.testAccounts}</p>
        </div>
        <div className="early-access-form">
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Profiles</h2>
          <p style={{ margin: 0 }}>Personal: {data.personalProfileCount}</p>
          <p style={{ margin: 0 }}>Business: {data.businessProfileCount}</p>
        </div>
      </div>

      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Agreements</h2>
        {Object.keys(data.agreementCountsByStatus).length === 0 ? (
          <p style={{ margin: 0 }}>No agreements yet.</p>
        ) : (
          Object.entries(data.agreementCountsByStatus).map(([status, statusCount]) => (
            <p style={{ margin: 0 }} key={status}>
              {status.replaceAll("_", " ")}: {statusCount}
            </p>
          ))
        )}
        <p style={{ margin: 0 }}>Signature events: {data.signatureEventCount}</p>
        <p style={{ margin: 0 }}>Signed PDFs: {data.agreementPdfCount}</p>
      </div>

      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Environment &amp; provider status</h2>
        <p style={{ margin: 0 }}>
          App env: {data.environmentStatus.appEnv} (Node: {data.environmentStatus.nodeEnv})
        </p>
        <p style={{ margin: 0 }}>Database: {formatStatusLabel(data.environmentStatus.database)}</p>
        <p style={{ margin: 0 }}>Document storage: {formatStatusLabel(data.environmentStatus.documentStorage)}</p>
        <p style={{ margin: 0 }}>
          Payment provider: {formatStatusLabel(data.environmentStatus.paymentProvider)} (
          {data.environmentStatus.paymentProviderEnvironment === "production" ? "LIVE — real money moves" : "sandbox — no real money moves"})
        </p>
        <p style={{ margin: 0 }}>
          KYC/KYB provider: {formatStatusLabel(data.environmentStatus.kycProvider)} (
          {data.environmentStatus.kycProviderEnvironment === "production" ? "LIVE — real identity verification" : "sandbox — not a real identity check"})
        </p>
        <p style={{ margin: 0 }}>Email delivery: {formatStatusLabel(data.environmentStatus.emailDelivery)}</p>
        <p style={{ margin: 0 }}>SMS delivery: {formatStatusLabel(data.environmentStatus.smsDelivery)}</p>
        <p style={{ margin: 0 }}>Scheduled jobs: {formatStatusLabel(data.environmentStatus.scheduledJobs)}</p>
      </div>

      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Recent administrative actions</h2>
        {data.recentAdminActions.length === 0 ? (
          <p style={{ margin: 0 }}>No administrative actions recorded yet.</p>
        ) : (
          <ul style={{ margin: 0, paddingInlineStart: "1.25rem" }}>
            {data.recentAdminActions.map((event) => (
              <li key={event.id} style={{ fontSize: "0.85rem" }}>
                {event.action} — {new Date(event.occurredAt).toLocaleString()}
                {event.targetResourceId ? ` — target ${event.targetResourceId}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Recent audit events (all)</h2>
        <ul style={{ margin: 0, paddingInlineStart: "1.25rem" }}>
          {data.recentAuditEvents.map((event) => (
            <li key={event.id} style={{ fontSize: "0.85rem" }}>
              {event.action} — {new Date(event.occurredAt).toLocaleString()}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
