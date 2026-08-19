"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatMoney } from "@/lib/ui/money";
import { reconciliationExceptionStatusLabel } from "@/lib/ui/statusLabels";

interface ReconciliationExceptionRecord {
  id: string;
  exceptionType: string;
  paymentAttemptId: string | null;
  providerEventId: string | null;
  status: "open" | "resolved";
  detectedAt: string;
  resolutionReason: string | null;
}

// PRSprint 23 (docs/prsprints/PRSPRINT_23_ACH_BANK_LINKING_RECONCILIATION.md) item 109: "Support
// should see provider references" — this per-agreement lookup surfaces exactly that, never a raw
// bank_account_ref/card_token (see ledgerAdminService.ts's own doc comment for what's omitted).
interface AdminPaymentAttemptSummary {
  id: string;
  status: string;
  paymentMethod: string | null;
  providerName: string;
  providerPaymentId: string | null;
  amountMinorUnits: number;
  currency: string;
  createdAt: string;
}
interface AdminAchMandateSummary {
  id: string;
  status: string;
  authorizedAt: string;
  revokedAt: string | null;
}
interface AdminDebitCardMethodSummary {
  id: string;
  status: string;
  cardLast4: string;
  cardBrand: string | null;
  expiresAtMonth: number;
  expiresAtYear: number;
}
interface AgreementLedgerView {
  balance: { originalPrincipalMinorUnits: number; amountPaidMinorUnits: number; remainingBalanceMinorUnits: number; settlementState: string; currency: string };
  entries: { id: string; entryType: string; paymentAttemptId: string; createdAt: string }[];
  exceptions: ReconciliationExceptionRecord[];
  paymentAttempts: AdminPaymentAttemptSummary[];
  activeAchMandate: AdminAchMandateSummary | null;
  activeDebitCard: AdminDebitCardMethodSummary | null;
}

const ACCOUNT_TYPES = [
  "processor_clearing",
  "creditor_proceeds_payable",
  "platform_fee_revenue",
  "processor_fee_expense",
  "creditor_clawback_exposure",
] as const;

export function AdminLedger() {
  const [isOwner, setIsOwner] = useState(false);
  const [exceptions, setExceptions] = useState<ReconciliationExceptionRecord[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [actionError, setActionError] = useState<string | null>(null);
  const [resolutionReasons, setResolutionReasons] = useState<Record<string, string>>({});

  const [lookupAgreementId, setLookupAgreementId] = useState("");
  const [lookupState, setLookupState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [lookupView, setLookupView] = useState<AgreementLedgerView | null>(null);

  const [adjustOpen, setAdjustOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [adjustSuccess, setAdjustSuccess] = useState<string | null>(null);
  const [form, setForm] = useState({
    paymentAttemptId: "",
    agreementId: "",
    currency: "USD",
    targetAccountType: ACCOUNT_TYPES[0] as (typeof ACCOUNT_TYPES)[number],
    direction: "debit" as "debit" | "credit",
    amount: "",
    reason: "",
  });

  useEffect(() => {
    void (async () => {
      apiFetch<{ platformRole: string }>("/api/admin/whoami")
        .then((body) => setIsOwner(body.platformRole === "platform_owner"))
        .catch(() => setIsOwner(false));
      await load();
    })();
  }, []);

  async function load() {
    try {
      const body = await apiFetch<{ exceptions: ReconciliationExceptionRecord[] }>("/api/admin/ledger/exceptions");
      setExceptions(body.exceptions);
      setState("ready");
    } catch {
      setState("error");
    }
  }

  async function handleResolve(exceptionId: string) {
    const resolutionReason = (resolutionReasons[exceptionId] ?? "").trim();
    if (!resolutionReason) return;
    setActionError(null);
    try {
      await apiFetch("/api/admin/ledger/exceptions/resolve", {
        method: "POST",
        body: JSON.stringify({ exceptionId, resolutionReason }),
      });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong resolving this exception.");
    }
  }

  async function handleLookup(event: React.FormEvent) {
    event.preventDefault();
    if (!lookupAgreementId.trim()) return;
    setLookupState("loading");
    try {
      const view = await apiFetch<AgreementLedgerView>(`/api/admin/ledger/agreement?agreementId=${encodeURIComponent(lookupAgreementId.trim())}`);
      setLookupView(view);
      setLookupState("ready");
    } catch {
      setLookupView(null);
      setLookupState("error");
    }
  }

  async function handleAdjustment(event: React.FormEvent) {
    event.preventDefault();
    if (confirmText !== "ADJUST") return;
    const amountMinorUnits = Math.round(Number(form.amount) * 100);
    if (!Number.isFinite(amountMinorUnits) || amountMinorUnits <= 0) {
      setActionError("Enter a valid positive amount.");
      return;
    }
    setAdjusting(true);
    setActionError(null);
    setAdjustSuccess(null);
    try {
      await apiFetch("/api/admin/ledger/adjustment", {
        method: "POST",
        body: JSON.stringify({
          paymentAttemptId: form.paymentAttemptId,
          agreementId: form.agreementId,
          currency: form.currency,
          targetAccountType: form.targetAccountType,
          direction: form.direction,
          amountMinorUnits,
          reason: form.reason,
        }),
      });
      setAdjustSuccess("Adjustment posted.");
      setConfirmText("");
      setForm({ ...form, paymentAttemptId: "", agreementId: "", amount: "", reason: "" });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong posting this adjustment.");
    } finally {
      setAdjusting(false);
    }
  }

  return (
    <div>
      {actionError && (
        <div className="form-status form-status--error" role="alert" style={{ marginBottom: "1rem" }}>
          {actionError}
        </div>
      )}

      <div className="card">
        <div className="card__header">
          <h2>Reconciliation exceptions</h2>
        </div>
        {state === "loading" && (
          <div aria-hidden="true">
            <div className="skeleton skeleton--line" />
          </div>
        )}
        {state === "error" && (
          <div className="form-status form-status--error" role="alert">
            Something went wrong loading exceptions. Please try again.
          </div>
        )}
        {state === "ready" && exceptions.length === 0 && (
          <div className="empty-state">
            <h3>No open exceptions</h3>
          </div>
        )}
        {state === "ready" &&
          exceptions.map((exception) => {
            const label = reconciliationExceptionStatusLabel(exception.status);
            return (
              <div className="card" key={exception.id}>
                <div className="card__header">
                  <h3>{exception.exceptionType.replace(/_/g, " ")}</h3>
                  <span className={`chip chip--${label.tone}`}>{label.label}</span>
                </div>
                {exception.paymentAttemptId && <p>Payment attempt: {exception.paymentAttemptId}</p>}
                {exception.status === "open" && (
                  <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
                    <div className="field" style={{ flex: 1, minWidth: "16rem" }}>
                      <label htmlFor={`resolution-${exception.id}`}>Resolution reason</label>
                      <input
                        id={`resolution-${exception.id}`}
                        value={resolutionReasons[exception.id] ?? ""}
                        onChange={(e) => setResolutionReasons((current) => ({ ...current, [exception.id]: e.target.value }))}
                      />
                    </div>
                    <button type="button" className="button button--primary" onClick={() => void handleResolve(exception.id)}>
                      Resolve
                    </button>
                  </div>
                )}
              </div>
            );
          })}
      </div>

      <div className="card">
        <div className="card__header">
          <h2>Agreement lookup — provider references</h2>
        </div>
        <form onSubmit={(e) => void handleLookup(e)} style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap", marginBottom: "1rem" }}>
          <div className="field" style={{ flex: 1, minWidth: "16rem" }}>
            <label htmlFor="lookup-agreement">Agreement ID</label>
            <input id="lookup-agreement" value={lookupAgreementId} onChange={(e) => setLookupAgreementId(e.target.value)} />
          </div>
          <button type="submit" className="button button--primary" disabled={lookupState === "loading"}>
            {lookupState === "loading" ? "Looking up…" : "Look up"}
          </button>
        </form>
        {lookupState === "error" && (
          <div className="form-status form-status--error" role="alert">
            Could not load this agreement&apos;s ledger view.
          </div>
        )}
        {lookupState === "ready" && lookupView && (
          <div style={{ display: "grid", gap: "1rem" }}>
            <p style={{ margin: 0 }}>
              Balance: {formatMoney(lookupView.balance.amountPaidMinorUnits, lookupView.balance.currency)} paid of{" "}
              {formatMoney(lookupView.balance.originalPrincipalMinorUnits, lookupView.balance.currency)} (
              {lookupView.balance.settlementState.replace(/_/g, " ")})
            </p>
            <div>
              <h3 style={{ fontSize: "0.95rem" }}>Payment attempts</h3>
              {lookupView.paymentAttempts.length === 0 ? (
                <p style={{ color: "var(--ink-soft)" }}>None.</p>
              ) : (
                <ul style={{ margin: 0, paddingInlineStart: "1.25rem" }}>
                  {lookupView.paymentAttempts.map((p) => (
                    <li key={p.id} style={{ fontSize: "0.85rem" }}>
                      {p.status} — {p.paymentMethod ?? "unspecified method"} —{" "}
                      {formatMoney(p.amountMinorUnits, p.currency)} — provider: {p.providerName}
                      {p.providerPaymentId ? ` (${p.providerPaymentId})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 style={{ fontSize: "0.95rem" }}>Active ACH mandate</h3>
              {lookupView.activeAchMandate ? (
                <p style={{ margin: 0, fontSize: "0.85rem" }}>
                  {lookupView.activeAchMandate.status} — authorized {new Date(lookupView.activeAchMandate.authorizedAt).toLocaleDateString()}
                </p>
              ) : (
                <p style={{ color: "var(--ink-soft)" }}>None.</p>
              )}
            </div>
            <div>
              <h3 style={{ fontSize: "0.95rem" }}>Active debit card on file</h3>
              {lookupView.activeDebitCard ? (
                <p style={{ margin: 0, fontSize: "0.85rem" }}>
                  {lookupView.activeDebitCard.cardBrand ?? "Card"} ending {lookupView.activeDebitCard.cardLast4} — expires{" "}
                  {lookupView.activeDebitCard.expiresAtMonth}/{lookupView.activeDebitCard.expiresAtYear} — {lookupView.activeDebitCard.status}
                </p>
              ) : (
                <p style={{ color: "var(--ink-soft)" }}>None.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {isOwner && (
        <div className="card">
          <div className="card__header">
            <h2>Manual ledger adjustment</h2>
            <button type="button" className="button button--ghost" onClick={() => setAdjustOpen((v) => !v)}>
              {adjustOpen ? "Cancel" : "New adjustment"}
            </button>
          </div>
          {adjustSuccess && <p className="form-status form-status--success">{adjustSuccess}</p>}
          {adjustOpen && (
            <form onSubmit={(e) => void handleAdjustment(e)} style={{ display: "grid", gap: "1rem", maxWidth: "28rem" }}>
              <div className="confirm-banner">
                This posts a real, balanced ledger entry against{" "}
                {formatMoney(Math.round(Number(form.amount || 0) * 100), form.currency)}. It cannot be undone —
                only reversed with another adjustment.
              </div>
              <div className="field">
                <label htmlFor="adj-payment">Payment attempt ID</label>
                <input id="adj-payment" required value={form.paymentAttemptId} onChange={(e) => setForm({ ...form, paymentAttemptId: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="adj-agreement">Agreement ID</label>
                <input id="adj-agreement" required value={form.agreementId} onChange={(e) => setForm({ ...form, agreementId: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="adj-account-type">Target account</label>
                <select
                  id="adj-account-type"
                  value={form.targetAccountType}
                  onChange={(e) => setForm({ ...form, targetAccountType: e.target.value as (typeof ACCOUNT_TYPES)[number] })}
                >
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="adj-direction">Direction</label>
                <select id="adj-direction" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as "debit" | "credit" })}>
                  <option value="debit">Debit</option>
                  <option value="credit">Credit</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="adj-amount">Amount ({form.currency})</label>
                <input id="adj-amount" required type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="adj-reason">Reason</label>
                <textarea id="adj-reason" required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="adj-confirm">Type ADJUST to confirm</label>
                <input id="adj-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
              </div>
              <div>
                <button type="submit" className="button button--primary" disabled={adjusting || confirmText !== "ADJUST"}>
                  {adjusting ? "Posting…" : "Post adjustment"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
