"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiFetch } from "@/lib/ui/apiFetch";
import { formatDate } from "@/lib/ui/date";
import { rescheduleRequestStatusLabel } from "@/lib/ui/statusLabels";

interface RescheduleRequestRecord {
  id: string;
  installmentScheduleItemId: string;
  agreementId: string;
  currentDueDate: string;
  requestedDueDate: string;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  decisionReason: string | null;
  createdAt: string;
}

type LoadStatus = "loading" | "ready" | "unauthorized" | "error" | "missing-agreement";

/**
 * Sprint 18B / Sprint 13: debtor request + creditor approve/reject view for
 * a single agreement's installment reschedules. Reached via
 * /payments/reschedule?agreementId=...(&installmentScheduleItemId=...) —
 * the installment id is expected to be deep-linked from wherever a
 * scheduled/past-due installment is shown (agreements/detail, owned by a
 * different part of this sprint); this page also accepts it as a manual
 * field so it works standalone.
 */
export function RescheduleRequest() {
  const searchParams = useSearchParams();
  const agreementId = searchParams.get("agreementId");
  const prefillInstallmentId = searchParams.get("installmentScheduleItemId") ?? "";

  const [status, setStatus] = useState<LoadStatus>("loading");
  const [requests, setRequests] = useState<RescheduleRequestRecord[]>([]);
  const [installmentId, setInstallmentId] = useState(prefillInstallmentId);
  const [newDate, setNewDate] = useState("");
  const [reason, setReason] = useState("");
  const [submitStatus, setSubmitStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!agreementId) {
      setStatus("missing-agreement");
      return;
    }
    try {
      const body = await apiFetch<{ requests: RescheduleRequestRecord[] }>(
        `/api/installments/reschedule/by-agreement?agreementId=${agreementId}`,
      );
      setRequests(body.requests);
      setStatus("ready");
    } catch (error: unknown) {
      if (error instanceof ApiError && error.httpStatus === 401) setStatus("unauthorized");
      else setStatus("error");
    }
  }, [agreementId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function handleSubmitRequest(event: React.FormEvent) {
    event.preventDefault();
    if (!agreementId || !installmentId || !newDate) return;
    setSubmitStatus("submitting");
    try {
      await apiFetch("/api/installments/reschedule/request", {
        method: "POST",
        body: JSON.stringify({
          installmentScheduleItemId: installmentId,
          agreementId,
          requestedDueDate: newDate,
          reason: reason.trim() ? reason.trim() : null,
        }),
      });
      setSubmitStatus("idle");
      setNewDate("");
      setReason("");
      await load();
    } catch {
      setSubmitStatus("error");
    }
  }

  async function handleDecide(requestId: string, decision: "approved" | "rejected") {
    setDecidingId(requestId);
    setDecideError(null);
    try {
      await apiFetch("/api/installments/reschedule/decide", {
        method: "POST",
        body: JSON.stringify({ requestId, decision, decisionReason: null }),
      });
      await load();
    } catch {
      setDecideError("Only the creditor may approve or reject a reschedule request.");
    } finally {
      setDecidingId(null);
    }
  }

  if (status === "missing-agreement") {
    return (
      <div className="empty-state">
        <h3>No agreement selected</h3>
        <p>Open this page from a specific agreement to request or review a reschedule.</p>
      </div>
    );
  }
  if (status === "loading") {
    return <div className="skeleton skeleton--card" />;
  }
  if (status === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert">
        You need to <a href="/login">sign in</a> to view reschedule requests.
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading reschedule requests. Please try again.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1.25rem" }}>
      <div className="card">
        <div className="card__header">
          <h2>Request a new due date</h2>
        </div>
        <form onSubmit={(event) => void handleSubmitRequest(event)} style={{ display: "grid", gap: "1rem" }}>
          {!prefillInstallmentId && (
            <div className="field">
              <label htmlFor="installment-id">Installment id</label>
              <input id="installment-id" required value={installmentId} onChange={(event) => setInstallmentId(event.target.value)} />
            </div>
          )}
          <div className="field">
            <label htmlFor="requested-date">Requested due date</label>
            <input id="requested-date" type="date" required value={newDate} onChange={(event) => setNewDate(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="reason">Reason (optional)</label>
            <textarea id="reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} />
          </div>
          {submitStatus === "error" && (
            <p className="field-error" role="alert">
              The reschedule request could not be submitted. Please check the details and try again.
            </p>
          )}
          <button type="submit" className="button button--primary" disabled={submitStatus === "submitting"}>
            {submitStatus === "submitting" ? "Submitting…" : "Submit request"}
          </button>
        </form>
        <p style={{ marginTop: "0.75rem", color: "var(--ink-soft)", fontSize: "0.82rem" }}>
          Submitting a request does not change the due date — the creditor must approve it first.
        </p>
      </div>

      <div className="card">
        <div className="card__header">
          <h2>Reschedule requests</h2>
        </div>
        {decideError && (
          <p className="field-error" role="alert">
            {decideError}
          </p>
        )}
        {requests.length === 0 ? (
          <div className="empty-state">
            <h3>No reschedule requests</h3>
            <p>Requests for this agreement will appear here.</p>
          </div>
        ) : (
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {requests.map((request) => {
              const { label, tone } = rescheduleRequestStatusLabel(request.status);
              return (
                <div key={request.id} className="card" style={{ padding: "1rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
                    <div>
                      <p style={{ margin: 0, fontWeight: 650 }}>
                        {formatDate(request.currentDueDate)} → {formatDate(request.requestedDueDate)}
                      </p>
                      {request.reason && <p style={{ margin: "0.35rem 0 0", color: "var(--ink-soft)" }}>{request.reason}</p>}
                    </div>
                    <span className={`chip chip--${tone}`}>{label}</span>
                  </div>
                  {request.status === "pending" && (
                    <div style={{ display: "flex", gap: "0.6rem", marginTop: "0.75rem" }}>
                      <button
                        type="button"
                        className="button button--primary"
                        disabled={decidingId === request.id}
                        onClick={() => void handleDecide(request.id, "approved")}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="button button--ghost"
                        disabled={decidingId === request.id}
                        onClick={() => void handleDecide(request.id, "rejected")}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
