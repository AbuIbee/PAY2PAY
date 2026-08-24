"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";

type MfaMethod = "totp" | "sms";

interface StepUpChallengeProps {
  /** Free-text label sent to the backend for audit only (e.g. "sign_agreement") — matches MfaService.completeStepUp's `action` param. */
  action: string;
  /** Human-readable description of what the user is about to confirm, e.g. "sign this agreement". */
  actionDescription: string;
  onVerified: () => void;
  onCancel: () => void;
}

/**
 * Sprint 2/18B: the shared step-up challenge UI. "For sensitive actions,
 * handle step-up seamlessly: action -> backend says step-up required -> UI
 * challenge -> success -> safely retry original action. Do not make raw 403
 * the user experience." Every sensitive-action flow (signing, settlement
 * approval, restriction appeal, staff role change, ...) renders this the
 * same way via useStepUpGuardedAction below, instead of each re-implementing
 * its own challenge UI.
 */
export function StepUpChallenge({ action, actionDescription, onVerified, onCancel }: StepUpChallengeProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<"checking" | "not_enrolled" | "ready" | "verifying" | "error">("checking");
  const [methods, setMethods] = useState<MfaMethod[]>([]);
  const [method, setMethod] = useState<MfaMethod>("totp");
  const [code, setCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  // Section B (closed-beta remediation, Product Owner review): factored out of the mount-time effect
  // below so "I've set it up — check again" (in the not_enrolled state further down) can re-run the
  // same check without closing this dialog — closing it would reject the pending action via onCancel,
  // losing whatever the user was in the middle of doing (e.g. signing an agreement) rather than
  // letting them resume it. Not itself wired into any effect's dependency array (it's re-invoked
  // explicitly by that button, never by an effect), so it doesn't need to be memoized.
  async function checkAndInitiate() {
    try {
      const body = await apiFetch<{ enrolled: boolean; methods: MfaMethod[] }>("/api/auth/mfa/status");
      const firstMethod = body.methods[0];
      if (!body.enrolled || !firstMethod) {
        setStatus("not_enrolled");
        return;
      }
      setMethods(body.methods);
      setMethod(firstMethod);
      await apiFetch("/api/auth/mfa/step-up/initiate", {
        method: "POST",
        body: JSON.stringify({ method: firstMethod }),
      });
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ enrolled: boolean; methods: MfaMethod[] }>("/api/auth/mfa/status");
        if (cancelled) return;
        const firstMethod = body.methods[0];
        if (!body.enrolled || !firstMethod) {
          setStatus("not_enrolled");
          return;
        }
        setMethods(body.methods);
        setMethod(firstMethod);
        await apiFetch("/api/auth/mfa/step-up/initiate", {
          method: "POST",
          body: JSON.stringify({ method: firstMethod }),
        });
        if (!cancelled) setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSwitchMethod = useCallback(async (next: MfaMethod) => {
    setMethod(next);
    setCode("");
    setErrorMessage(null);
    try {
      await apiFetch("/api/auth/mfa/step-up/initiate", { method: "POST", body: JSON.stringify({ method: next }) });
    } catch {
      setErrorMessage("Could not send a new code. Please try again.");
    }
  }, []);

  async function handleVerify(event: React.FormEvent) {
    event.preventDefault();
    setStatus("verifying");
    setErrorMessage(null);
    try {
      const body = await apiFetch<{ passed: boolean }>("/api/auth/mfa/step-up/verify", {
        method: "POST",
        body: JSON.stringify({ method, code, action }),
      });
      if (body.passed) {
        onVerified();
        return;
      }
      setErrorMessage("That code wasn't accepted. Please try again.");
      setStatus("ready");
    } catch {
      setErrorMessage("That code wasn't accepted, or too many attempts were made. Please try again shortly.");
      setStatus("ready");
    }
  }

  return (
    <dialog ref={dialogRef} className="dialog" aria-labelledby="step-up-title" onCancel={onCancel}>
      <div className="dialog__panel">
        <h2 id="step-up-title" className="dialog__title">
          Verify it&apos;s you
        </h2>
        <p className="dialog__body">
          For your security, confirm a fresh verification code before we {actionDescription}.
        </p>

        {status === "checking" && <p role="status">Checking your verification methods…</p>}

        {status === "not_enrolled" && (
          <div className="form-status form-status--error" role="alert">
            You need to set up two-factor authentication before completing this action.{" "}
            <a href="/account/security" target="_blank" rel="noopener noreferrer">
              Set it up in a new tab
            </a>
            , then come back here.
            <div style={{ marginTop: "0.75rem" }}>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setStatus("checking");
                  void checkAndInitiate();
                }}
              >
                I&apos;ve set it up — check again
              </button>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="form-status form-status--error" role="alert">
            Something went wrong starting verification. Please try again.
          </div>
        )}

        {(status === "ready" || status === "verifying") && (
          <form onSubmit={(event) => void handleVerify(event)}>
            {methods.length > 1 && (
              <div className="field" style={{ marginBottom: "1rem" }}>
                <label htmlFor="step-up-method">Verification method</label>
                <select
                  id="step-up-method"
                  value={method}
                  onChange={(event) => void handleSwitchMethod(event.target.value as MfaMethod)}
                >
                  {methods.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {candidate === "totp" ? "Authenticator app" : "Text message"}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="step-up-code">
                {method === "totp" ? "Code from your authenticator app" : "Code sent by text message"}
              </label>
              <input
                id="step-up-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                autoFocus
              />
            </div>
            {errorMessage && (
              <p className="field-error" role="alert">
                {errorMessage}
              </p>
            )}
            <div className="dialog__actions">
              <button type="button" className="button button--ghost" onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" className="button button--primary" disabled={status === "verifying" || code.length !== 6}>
                {status === "verifying" ? "Verifying…" : "Verify"}
              </button>
            </div>
          </form>
        )}

        {status === "not_enrolled" && (
          <div className="dialog__actions">
            <button type="button" className="button button--ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}
