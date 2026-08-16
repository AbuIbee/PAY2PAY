"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";

type MfaMethod = "totp" | "sms";
type LoadState = "loading" | "ready" | "error";

interface MfaStatus {
  enrolled: boolean;
  methods: MfaMethod[];
}

/**
 * Sprint 2/18B: MFA enrollment. No QR-code rendering library exists in this
 * project (and adding one is out of this sprint's scope) — the TOTP secret
 * and otpauth URI are shown as plain text/code, which any authenticator app
 * can still accept via manual entry.
 */
export function AccountSecurity() {
  const [state, setState] = useState<LoadState>("loading");
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [mode, setMode] = useState<"idle" | "totp" | "sms">("idle");

  async function refresh() {
    try {
      const body = await apiFetch<MfaStatus>("/api/auth/mfa/status");
      setStatus(body);
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
        <div className="skeleton skeleton--line" style={{ width: "40%" }} />
        <div className="skeleton skeleton--line" style={{ width: "70%" }} />
      </div>
    );
  }

  if (state === "error" || !status) {
    return (
      <div className="form-status form-status--error" role="alert">
        Something went wrong loading your security settings. Please try again.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <div className="card">
        <div className="card__header">
          <h2>Two-factor authentication</h2>
          {status.enrolled ? <span className="chip chip--success">Enabled</span> : <span className="chip chip--warning">Not set up</span>}
        </div>
        {status.enrolled ? (
          <p style={{ color: "var(--ink-soft)" }}>
            Enabled via {status.methods.map((m) => (m === "totp" ? "authenticator app" : "text message")).join(" and ")}.
            You&apos;ll be asked for a fresh code before sensitive actions like signing an agreement or approving a
            settlement.
          </p>
        ) : (
          <p style={{ color: "var(--ink-soft)" }}>
            Set up two-factor authentication to protect sensitive actions like signing agreements and approving
            settlements.
          </p>
        )}

        {mode === "idle" && (
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
            <button type="button" className="button button--primary" onClick={() => setMode("totp")}>
              {status.methods.includes("totp") ? "Re-add authenticator app" : "Set up authenticator app"}
            </button>
            <button type="button" className="button button--ghost" onClick={() => setMode("sms")}>
              {status.methods.includes("sms") ? "Re-add text message" : "Set up text message"}
            </button>
          </div>
        )}

        {mode === "totp" && <TotpEnroll onDone={() => { setMode("idle"); void refresh(); }} onCancel={() => setMode("idle")} />}
        {mode === "sms" && <SmsEnroll onDone={() => { setMode("idle"); void refresh(); }} onCancel={() => setMode("idle")} />}
      </div>

      <SignedInDevices />
    </div>
  );
}

interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
}

/**
 * PRSprint 06 (docs/prsprints/PRSPRINT_06_AUTHENTICATION_SESSION_HARDENING.md): "Device/session
 * visibility" and self-service "log out everywhere" — the gap this component's Sprint 18B doc
 * comment previously flagged as deliberately not built (no list-by-user repository method
 * existed). Now backed by GET/POST /api/account/sessions*.
 */
function SignedInDevices() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>("loading");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function refresh() {
    try {
      const body = await apiFetch<{ sessions: SessionSummary[] }>("/api/account/sessions");
      setSessions(body.sessions);
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

  async function handleRevoke(sessionId: string, isCurrent: boolean) {
    setErrorMessage(null);
    setPendingId(sessionId);
    try {
      await apiFetch("/api/account/sessions/revoke", { method: "POST", body: JSON.stringify({ sessionId }) });
      if (isCurrent) {
        router.push("/login");
        router.refresh();
        return;
      }
      await refresh();
    } catch {
      setErrorMessage("Couldn't sign out that device. Please try again.");
    } finally {
      setPendingId(null);
    }
  }

  async function handleLogoutAll() {
    setErrorMessage(null);
    setLoggingOutAll(true);
    try {
      await apiFetch("/api/account/sessions/logout-all", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch {
      setErrorMessage("Couldn't sign out of all devices. Please try again.");
      setLoggingOutAll(false);
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <h2>Signed-in devices</h2>
        {sessions.length > 1 && (
          <button type="button" className="button button--ghost" onClick={() => void handleLogoutAll()} disabled={loggingOutAll}>
            {loggingOutAll ? "Signing out everywhere…" : "Log out of all devices"}
          </button>
        )}
      </div>

      {state === "loading" && (
        <div aria-hidden="true">
          <div className="skeleton skeleton--line" style={{ width: "60%" }} />
        </div>
      )}

      {state === "error" && (
        <p className="form-status form-status--error" role="alert">
          Something went wrong loading your signed-in devices. Please try again.
        </p>
      )}

      {errorMessage && (
        <p className="field-error" role="alert">
          {errorMessage}
        </p>
      )}

      {state === "ready" && (
        <ul style={{ listStyle: "none", margin: "1rem 0 0", padding: 0, display: "grid", gap: "0.75rem" }}>
          {sessions.map((session) => (
            <li
              key={session.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "1rem",
                padding: "0.75rem",
                border: "1px solid var(--border-soft)",
                borderRadius: "0.5rem",
              }}
            >
              <div>
                <div>
                  {session.userAgent ?? "Unknown device"}{" "}
                  {session.isCurrent && <span className="chip chip--success">This device</span>}
                </div>
                <small style={{ color: "var(--ink-soft)" }}>
                  {session.ipAddress ?? "Unknown location"} · last active {new Date(session.lastSeenAt).toLocaleString()}
                </small>
              </div>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void handleRevoke(session.id, session.isCurrent)}
                disabled={pendingId === session.id}
              >
                {session.isCurrent ? "Sign out" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TotpEnroll({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [step, setStep] = useState<"loading" | "confirm" | "submitting" | "error">("loading");
  const [secret, setSecret] = useState("");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [code, setCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ secret: string; otpauthUri: string }>("/api/auth/mfa/totp/enroll", { method: "POST" });
        if (cancelled) return;
        setSecret(body.secret);
        setOtpauthUri(body.otpauthUri);
        setStep("confirm");
      } catch {
        if (!cancelled) setStep("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleConfirm(event: React.FormEvent) {
    event.preventDefault();
    setStep("submitting");
    setErrorMessage(null);
    try {
      await apiFetch("/api/auth/mfa/totp/confirm", { method: "POST", body: JSON.stringify({ code }) });
      onDone();
    } catch {
      setErrorMessage("That code wasn't accepted. Please try again.");
      setStep("confirm");
    }
  }

  if (step === "loading") return <p role="status" style={{ marginTop: "1rem" }}>Setting up…</p>;
  if (step === "error") {
    return (
      <div className="form-status form-status--error" role="alert" style={{ marginTop: "1rem" }}>
        Something went wrong. <button type="button" className="button button--ghost" onClick={onCancel}>Close</button>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void handleConfirm(event)} style={{ marginTop: "1rem", display: "grid", gap: "1rem" }}>
      <div className="field">
        <label>Setup key (enter manually in your authenticator app)</label>
        <code style={{ display: "block", padding: "0.6rem", background: "var(--forest-50)", borderRadius: "0.5rem", wordBreak: "break-all" }}>
          {secret}
        </code>
        <small>Or paste this URI if your app supports it: {otpauthUri}</small>
      </div>
      <div className="field">
        <label htmlFor="totp-confirm-code">6-digit code from your app</label>
        <input
          id="totp-confirm-code"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
        />
      </div>
      {errorMessage && <p className="field-error" role="alert">{errorMessage}</p>}
      <div style={{ display: "flex", gap: "0.75rem" }}>
        <button type="button" className="button button--ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="button button--primary" disabled={step !== "confirm" || code.length !== 6}>
          Confirm
        </button>
      </div>
    </form>
  );
}

function SmsEnroll({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [step, setStep] = useState<"phone" | "confirm" | "error">("phone");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSendCode(event: React.FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    try {
      await apiFetch("/api/auth/mfa/sms/enroll", { method: "POST", body: JSON.stringify({ phoneNumber }) });
      setStep("confirm");
    } catch {
      setErrorMessage("Couldn't send a code to that number. Please check it and try again.");
    }
  }

  async function handleConfirm(event: React.FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    try {
      await apiFetch("/api/auth/mfa/sms/confirm", { method: "POST", body: JSON.stringify({ code }) });
      onDone();
    } catch {
      setErrorMessage("That code wasn't accepted. Please try again.");
    }
  }

  if (step === "phone") {
    return (
      <form onSubmit={(event) => void handleSendCode(event)} style={{ marginTop: "1rem", display: "grid", gap: "1rem" }}>
        <div className="field">
          <label htmlFor="sms-phone">Phone number</label>
          <input id="sms-phone" type="tel" placeholder="+15551234567" required value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} />
        </div>
        {errorMessage && <p className="field-error" role="alert">{errorMessage}</p>}
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button type="button" className="button button--ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="button button--primary">Send code</button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={(event) => void handleConfirm(event)} style={{ marginTop: "1rem", display: "grid", gap: "1rem" }}>
      <div className="field">
        <label htmlFor="sms-confirm-code">6-digit code sent by text message</label>
        <input
          id="sms-confirm-code"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
        />
      </div>
      {errorMessage && <p className="field-error" role="alert">{errorMessage}</p>}
      <div style={{ display: "flex", gap: "0.75rem" }}>
        <button type="button" className="button button--ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="button button--primary" disabled={code.length !== 6}>Confirm</button>
      </div>
    </form>
  );
}
