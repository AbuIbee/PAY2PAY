"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { formatMoney } from "@/lib/ui/money";
import { formatDate } from "@/lib/ui/date";

interface PublicInvitationView {
  senderDisplayName: string;
  senderBusinessName: string | null;
  amountMinorUnits: number;
  currency: string;
  paymentFrequency: "weekly" | "biweekly" | "monthly";
  firstPaymentDate: string;
  numberOfPayments: number;
  totalRepaymentMinorUnits: number;
  feeAllocation: "creditor_pays" | "debtor_pays" | "split_evenly";
  message: string | null;
  proposalVersion: number;
  status: "pending" | "viewed" | "accepted" | "declined" | "expired" | "revoked";
  expiresAt: string;
}

const FREQUENCY_LABEL: Record<string, string> = { weekly: "Weekly", biweekly: "Every two weeks", monthly: "Monthly" };

type LoadState = "loading" | "ready" | "invalid" | "error";
type Mode = "review" | "request_changes";

/**
 * PRSprint 10 (docs/prsprints/PRSPRINT_10_INVITATION_IDENTITY_CLAIMING_ACCEPTANCE.md): the
 * anonymous-review page. Rendered for both signed-out and signed-in visitors — the GET this
 * component issues on mount (via resolvePublic) never mutates beyond the safe, idempotent,
 * scanner-tolerant `pending -> viewed` transition (see AgreementInvitationService.resolvePublic's
 * own doc comment). "Accept"/"Request Changes" redirect to login/signup with `?next=/i/<token>` —
 * the same param LoginForm/SignupForm already read (Sprint 18B) — when signed out; "Decline" never
 * requires authentication at all (this PRSprint's own acceptance criteria names verified identity
 * as required only for "Formal Accept/Counter").
 */
export function AgreementInvitationReview({ token }: { token: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<LoadState>("loading");
  const [view, setView] = useState<PublicInvitationView | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [mode, setMode] = useState<Mode>("review");
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const resumedIntent = useRef(false);

  async function refresh() {
    try {
      const [invitationView, me] = await Promise.all([
        apiFetch<PublicInvitationView>(`/api/agreement-invitations/resolve?token=${encodeURIComponent(token)}`),
        apiFetch<{ id: string }>("/api/auth/me").catch(() => null),
      ]);
      setView(invitationView);
      setAuthenticated(!!me);
      setState("ready");
    } catch {
      setState("invalid");
    }
  }

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // "Preserve Original Intent" — after returning from login/signup with ?intent=..., resume the
  // action the visitor originally clicked, exactly once, instead of leaving them back on a plain
  // review page with no memory of what they were doing.
  useEffect(() => {
    if (state !== "ready" || !authenticated || resumedIntent.current) return;
    const intent = searchParams.get("intent");
    void (async () => {
      if (intent === "accept") {
        resumedIntent.current = true;
        await handleAccept();
      } else if (intent === "request_changes") {
        resumedIntent.current = true;
        setMode("request_changes");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, authenticated]);

  function goAuthenticate(intent: "accept" | "request_changes") {
    const next = encodeURIComponent(`/i/${token}?intent=${intent}`);
    router.push(`/login?next=${next}`);
  }

  async function resolveActingProfile(): Promise<{ kind: "personal" | "business"; id: string }> {
    const active = await apiFetch<{ kind: "personal" | "business"; personalProfileId?: string; businessProfileId?: string }>(
      "/api/profiles/active",
    );
    const id = active.kind === "business" ? active.businessProfileId : active.personalProfileId;
    if (!id) throw new Error("No active profile.");
    return { kind: active.kind, id };
  }

  async function handleAccept() {
    if (!authenticated) return goAuthenticate("accept");
    setWorking(true);
    setActionError(null);
    try {
      const actingProfile = await resolveActingProfile();
      const result = await apiFetch<{ agreementId: string }>("/api/agreement-invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token, actingProfile }),
      });
      // Return the user directly to the agreement — never a generic dashboard.
      router.push(`/agreements/detail?id=${result.agreementId}`);
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Couldn't accept this proposal. Please try again.");
      setWorking(false);
    }
  }

  async function handleDecline() {
    if (!window.confirm("Decline this proposal? The sender will be notified.")) return;
    setWorking(true);
    setActionError(null);
    try {
      await apiFetch("/api/agreement-invitations/decline", { method: "POST", body: JSON.stringify({ token }) });
      await refresh();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Couldn't decline this proposal. Please try again.");
    } finally {
      setWorking(false);
    }
  }

  function handleRequestChanges() {
    if (!authenticated) return goAuthenticate("request_changes");
    setMode("request_changes");
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // Clipboard access can fail (permissions, non-secure context) — silently ignored, the link is
      // always visible in the address bar as a fallback.
    }
  }

  if (state === "loading") {
    return <p role="status">Loading…</p>;
  }
  if (state === "invalid" || !view) {
    return (
      <div className="form-status form-status--error" role="alert">
        This invitation link is invalid or has expired. If you believe this is a mistake, ask the sender to resend it.
      </div>
    );
  }

  const isOpen = view.status === "pending" || view.status === "viewed";

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "34rem" }}>
      <div className="early-access-form">
        <h1 style={{ margin: 0, fontSize: "1.3rem" }}>
          {view.senderBusinessName ?? view.senderDisplayName} sent you a payment plan proposal
        </h1>
        {view.senderBusinessName && <p style={{ margin: 0, color: "var(--ink-soft)" }}>via {view.senderDisplayName}</p>}
        {view.message && <p style={{ marginTop: "0.5rem" }}>&ldquo;{view.message}&rdquo;</p>}
      </div>

      <div className="early-access-form" style={{ display: "grid", gap: "0.4rem" }}>
        <p style={{ margin: 0 }}>
          <strong>Total amount:</strong> {formatMoney(view.amountMinorUnits, view.currency)}
        </p>
        <p style={{ margin: 0 }}>
          <strong>Frequency:</strong> {FREQUENCY_LABEL[view.paymentFrequency]}
        </p>
        <p style={{ margin: 0 }}>
          <strong>First payment:</strong> {formatDate(view.firstPaymentDate)}
        </p>
        <p style={{ margin: 0 }}>
          <strong>Number of payments:</strong> {view.numberOfPayments}
        </p>
        <p style={{ margin: 0 }}>
          <strong>Total repayment:</strong> {formatMoney(view.totalRepaymentMinorUnits, view.currency)}
        </p>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--ink-soft)" }}>
          Proposal version {view.proposalVersion} · {isOpen ? `Expires ${formatDate(view.expiresAt)}` : `Status: ${view.status}`}
        </p>
      </div>

      {actionError && (
        <p className="form-status form-status--error" role="alert">
          {actionError}
        </p>
      )}

      {isOpen && mode === "review" && (
        <div className="hero__actions" style={{ flexWrap: "wrap" }}>
          <button type="button" className="button button--primary" disabled={working} onClick={() => void handleAccept()}>
            Accept plan
          </button>
          <button type="button" className="button button--ghost" disabled={working} onClick={handleRequestChanges}>
            Request changes
          </button>
          <button type="button" className="button button--ghost" disabled={working} onClick={() => void handleDecline()}>
            Decline
          </button>
          <button type="button" className="button button--ghost" onClick={() => void handleCopyLink()}>
            Copy link
          </button>
        </div>
      )}

      {isOpen && mode === "request_changes" && authenticated && (
        <RequestChangesForm
          token={token}
          initial={view}
          onDone={() => {
            setMode("review");
            void refresh();
          }}
          onCancel={() => setMode("review")}
        />
      )}

      {!isOpen && (
        <p className="form-status">
          {view.status === "accepted"
            ? "This proposal has already been accepted."
            : view.status === "declined"
              ? "This proposal was declined."
              : view.status === "revoked"
                ? "This invitation was cancelled by the sender."
                : "This invitation has expired."}
        </p>
      )}

      <p style={{ fontSize: "0.8rem", color: "var(--ink-soft)" }}>
        This is a secure, private proposal. Only you can review it with this link. Accepting, requesting changes, or signing
        requires a free Paid2You account so we can verify your identity — no payment is ever collected without your explicit
        authorization.
      </p>
    </div>
  );
}

function RequestChangesForm({
  token,
  initial,
  onDone,
  onCancel,
}: {
  token: string;
  initial: PublicInvitationView;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(String(initial.amountMinorUnits / 100));
  const [installment, setInstallment] = useState(String(initial.amountMinorUnits / 100));
  const [frequency, setFrequency] = useState(initial.paymentFrequency);
  const [firstPaymentDate, setFirstPaymentDate] = useState(initial.firstPaymentDate);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const amountMinorUnits = Math.round(Number(amount) * 100);
      const installmentAmountMinorUnits = Math.round(Number(installment) * 100);
      await apiFetch("/api/agreement-invitations/propose", {
        method: "POST",
        body: JSON.stringify({
          token,
          message: message || undefined,
          terms: {
            originalAmountMinorUnits: amountMinorUnits,
            firstPaymentMinorUnits: installmentAmountMinorUnits,
            installmentAmountMinorUnits,
            frequency,
            firstPaymentDate,
            feeAllocation: initial.feeAllocation,
          },
        }),
      });
      onDone();
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : "Couldn't submit your requested changes. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="early-access-form">
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Propose different terms</h2>
      <form onSubmit={(event) => void handleSubmit(event)} style={{ display: "grid", gap: "1rem", marginTop: "0.75rem" }}>
        <div className="field">
          <label htmlFor="rc-amount">Total amount ({initial.currency})</label>
          <input id="rc-amount" type="number" min="0.01" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="rc-installment">Payment amount ({initial.currency})</label>
          <input id="rc-installment" type="number" min="0.01" step="0.01" required value={installment} onChange={(e) => setInstallment(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="rc-frequency">Frequency</label>
          <select id="rc-frequency" value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
            {Object.entries(FREQUENCY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rc-first-date">First payment date</label>
          <input id="rc-first-date" type="date" required value={firstPaymentDate} onChange={(e) => setFirstPaymentDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="rc-message">Message (optional)</label>
          <input id="rc-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
        </div>
        {errorMessage && <p className="field-error" role="alert">{errorMessage}</p>}
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button type="button" className="button button--ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="button button--primary" disabled={submitting}>
            {submitting ? "Sending…" : "Send proposed changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
