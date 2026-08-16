"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface DashboardData {
  email: string;
  mfaEnrolled: boolean;
}

type LoadStatus = "loading" | "ready" | "unauthorized" | "error";
type MfaEnrollStep = "choose" | "totp-confirm" | "sms-confirm" | "done";

export function AccountDashboard() {
  const router = useRouter();
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [data, setData] = useState<DashboardData | null>(null);
  const [mfaStep, setMfaStep] = useState<MfaEnrollStep>("choose");
  const [totpSecret, setTotpSecret] = useState<string | null>(null);
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [mfaMessage, setMfaMessage] = useState<string | null>(null);
  const [mfaError, setMfaError] = useState<string | null>(null);

  async function loadDashboard() {
    try {
      const response = await fetch("/api/account/dashboard");
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
    } catch {
      setLoadStatus("error");
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

  async function beginTotp() {
    setMfaError(null);
    const response = await fetch("/api/auth/mfa/totp/enroll", { method: "POST" });
    if (!response.ok) {
      setMfaError("Could not start authenticator-app enrollment.");
      return;
    }
    const body = (await response.json()) as { secret: string; otpauthUri: string };
    setTotpSecret(body.secret);
    setTotpUri(body.otpauthUri);
    setMfaStep("totp-confirm");
  }

  async function confirmTotp(code: string) {
    setMfaError(null);
    const response = await fetch("/api/auth/mfa/totp/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setMfaError(body?.message ?? "Incorrect code.");
      return;
    }
    setMfaStep("done");
    await loadDashboard();
  }

  async function beginSms() {
    setMfaError(null);
    const response = await fetch("/api/auth/mfa/sms/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setMfaError(body?.message ?? "Could not send a code to that number.");
      return;
    }
    setMfaStep("sms-confirm");
  }

  async function confirmSms(code: string) {
    setMfaError(null);
    const response = await fetch("/api/auth/mfa/sms/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setMfaError(body?.message ?? "Incorrect code.");
      return;
    }
    setMfaStep("done");
    await loadDashboard();
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
          <strong>Email:</strong> {data.email}
        </p>
        <p style={{ margin: 0 }}>
          <strong>Multifactor authentication:</strong> {data.mfaEnrolled ? "Enrolled" : "Not enrolled"}
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
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Multifactor authentication</h2>
        <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.9rem" }}>
          Required before sensitive actions (signing an agreement, changing payout details, and more)
          become available in later phases.
        </p>

        {mfaStep === "choose" ? (
          <div className="hero__actions">
            <button type="button" className="button button--primary" onClick={() => void beginTotp()}>
              Set up an authenticator app
            </button>
            <button type="button" className="button button--ghost" onClick={() => setMfaStep("sms-confirm")}>
              Use SMS instead
            </button>
          </div>
        ) : null}

        {mfaStep === "totp-confirm" && totpSecret ? (
          <div style={{ display: "grid", gap: "0.6rem" }}>
            <p style={{ margin: 0, fontSize: "0.85rem" }}>
              Add this key to your authenticator app: <code>{totpSecret}</code>
            </p>
            <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--ink-soft)", wordBreak: "break-all" }}>
              {totpUri}
            </p>
            <TotpConfirmField onSubmit={confirmTotp} />
          </div>
        ) : null}

        {mfaStep === "sms-confirm" && !phoneNumber ? (
          <PhoneNumberField
            value={phoneNumber}
            onChange={setPhoneNumber}
            onSubmit={() => void beginSms()}
          />
        ) : null}

        {mfaStep === "sms-confirm" && phoneNumber ? <CodeField onSubmit={confirmSms} label="SMS code" /> : null}

        {mfaStep === "done" ? (
          <p className="form-status form-status--success">Multifactor authentication is enrolled.</p>
        ) : null}

        {mfaError ? (
          <p className="form-status form-status--error" role="alert">
            {mfaError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function TotpConfirmField({ onSubmit }: { onSubmit: (code: string) => void | Promise<void> }) {
  const [code, setCode] = useState("");
  return (
    <div className="field">
      <label htmlFor="totp-code">Enter the 6-digit code</label>
      <input id="totp-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={6} />
      <button type="button" className="button button--primary" onClick={() => void onSubmit(code)}>
        Confirm
      </button>
    </div>
  );
}

function PhoneNumberField({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="field">
      <label htmlFor="sms-phone">Phone number</label>
      <input
        id="sms-phone"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="+15551234567"
      />
      <button type="button" className="button button--primary" onClick={onSubmit}>
        Send code
      </button>
    </div>
  );
}

function CodeField({ onSubmit, label }: { onSubmit: (code: string) => void | Promise<void>; label: string }) {
  const [code, setCode] = useState("");
  return (
    <div className="field">
      <label htmlFor="sms-code">{label}</label>
      <input id="sms-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={6} />
      <button type="button" className="button button--primary" onClick={() => void onSubmit(code)}>
        Confirm
      </button>
    </div>
  );
}
