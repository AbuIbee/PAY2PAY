"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface DashboardData {
  email: string;
  mfaEnrolled: boolean;
  publicReference: string;
}

type LoadStatus = "loading" | "ready" | "unauthorized" | "error";

export function AccountDashboard() {
  const router = useRouter();
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [data, setData] = useState<DashboardData | null>(null);
  const [exportStatus, setExportStatus] = useState<"idle" | "working" | "error">("idle");
  const [mfaMessage, setMfaMessage] = useState<string | null>(null);

  async function handleExportData() {
    setExportStatus("working");
    try {
      const response = await fetch("/api/account/export");
      if (!response.ok) throw new Error("export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pay2pay-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setExportStatus("idle");
    } catch {
      setExportStatus("error");
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account/dashboard")
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 401) {
          setLoadStatus("unauthorized");
          return;
        }
        if (!response.ok) {
          setLoadStatus("error");
          return;
        }
        setData((await response.json()) as DashboardData);
        setLoadStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setLoadStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    // PRSprint 10A: matches AppNav.tsx's own logout handler — forces Next's client-side Router
    // Cache to drop any already-rendered protected-page segments, so a same-tab navigation right
    // after logout can never serve stale cached content instead of re-checking the session.
    router.refresh();
  }

  async function handleResendVerification() {
    setMfaMessage(null);
    const response = await fetch("/api/auth/resend-verification", { method: "POST" });
    setMfaMessage(response.ok ? "Verification email sent." : "Could not send verification email.");
  }

  if (loadStatus === "loading") {
    return <p role="status">Loading account…</p>;
  }

  if (loadStatus === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        You need to <a href="/login">sign in</a> to view your account.
      </p>
    );
  }

  if (loadStatus === "error" || !data) {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        Something went wrong loading your account. Please try again.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "32rem" }}>
      <div className="early-access-form">
        <p style={{ margin: 0 }}>
          <strong>Account reference:</strong> <code>{data.publicReference}</code>
        </p>
        <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.85rem" }}>
          Share this reference (not your email) when contacting support about your account.
        </p>
        <p style={{ margin: 0 }}>
          <strong>Email:</strong> {data.email}
        </p>
        <div className="hero__actions" style={{ marginTop: "0.5rem" }}>
          <Link className="button button--ghost" href="/dashboard">
            Go to dashboard
          </Link>
          <button type="button" className="button button--ghost" onClick={() => void handleResendVerification()}>
            Resend verification email
          </button>
          <button type="button" className="button button--ghost" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
        {mfaMessage ? <p className="form-status form-status--success">{mfaMessage}</p> : null}
      </div>

      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Two-factor authentication</h2>
        <p style={{ margin: 0 }}>
          <strong>Status:</strong> {data.mfaEnrolled ? "Enrolled" : "Not enrolled"}
        </p>
        <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.9rem" }}>
          Required before sensitive actions (signing an agreement, changing payout details, and more).
        </p>
        <div className="hero__actions" style={{ marginTop: "0.5rem" }}>
          <Link className="button button--primary" href="/account/security">
            {data.mfaEnrolled ? "Manage two-factor authentication" : "Set up two-factor authentication"}
          </Link>
        </div>
      </div>

      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Your data</h2>
        <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.9rem" }}>
          Download a copy of your account information, agreements, and consent history as a JSON file.
        </p>
        <div className="hero__actions">
          <button type="button" className="button button--ghost" disabled={exportStatus === "working"} onClick={() => void handleExportData()}>
            {exportStatus === "working" ? "Preparing…" : "Download my data"}
          </button>
        </div>
        {exportStatus === "error" ? (
          <p className="form-status form-status--error" role="alert">
            We couldn&apos;t prepare your data export. Please try again.
          </p>
        ) : null}
      </div>
    </div>
  );
}
