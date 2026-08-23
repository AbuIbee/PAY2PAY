"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { formatDateTime } from "@/lib/ui/date";

type RiskSignalSeverity = "info" | "low" | "medium" | "high";

interface RiskEventRecord {
  id: string;
  userId: string;
  signalType: string;
  severity: RiskSignalSeverity;
  outcome: string;
  relatedResourceType: string | null;
  relatedResourceId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
  reviewState: "open" | "reviewed" | "dismissed";
  reviewedByUserId: string | null;
  reviewedAt: string | null;
}

const SEVERITY_TONE: Record<RiskSignalSeverity, string> = {
  info: "neutral",
  low: "neutral",
  medium: "warning",
  high: "danger",
};

function signalTypeLabel(value: string): string {
  return value.replaceAll("_", " ");
}

/**
 * SPRINT_20_ClosedBetaReadiness: Sprint 19 built the fraud/risk signal model (GET /api/admin/
 * risk-events, POST /api/admin/risk-events/review, gated by the review_fraud_alert capability) but
 * shipped it with zero UI — API-only. This is the first real admin surface for it. Recording a
 * signal never blocks anything (this codebase's own established rule); this page only gives an
 * admin visibility and a review decision, never an automated action against the flagged user.
 */
export function AdminRiskEvents() {
  const [openOnly, setOpenOnly] = useState(true);
  const [events, setEvents] = useState<RiskEventRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const body = await apiFetch<{ events: RiskEventRecord[] }>(`/api/admin/risk-events?openOnly=${openOnly}&limit=100`);
      setEvents(body.events);
    } catch (error) {
      if (error instanceof ApiError && error.httpStatus === 403) {
        setLoadError("You do not have the review_fraud_alert capability required to view risk signals.");
      } else {
        setLoadError(error instanceof Error ? error.message : "Something went wrong loading risk signals.");
      }
      setEvents(null);
    } finally {
      setLoading(false);
    }
  }, [openOnly]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function handleReview(id: string, decision: "reviewed" | "dismissed") {
    setPendingId(id);
    setActionError(null);
    try {
      await apiFetch("/api/admin/risk-events/review", { method: "POST", body: JSON.stringify({ id, decision }) });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong recording this review decision.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div>
      <div className="card">
        <div className="card__header">
          <h2>Risk &amp; fraud signals</h2>
        </div>
        <p style={{ marginTop: 0 }}>
          Recorded signals are visibility only — nothing here automatically restricts or accuses a user. Use the
          existing restriction/appeal tools if action is warranted.
        </p>
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={openOnly} onChange={(event) => setOpenOnly(event.target.checked)} />
          Show open (unreviewed) signals only
        </label>
      </div>

      {loading && <p role="status">Loading…</p>}

      {loadError && (
        <div className="form-status form-status--error" role="alert" style={{ marginTop: "1rem" }}>
          {loadError}
        </div>
      )}

      {actionError && (
        <p className="field-error" role="alert">
          {actionError}
        </p>
      )}

      {events && (
        <div className="card">
          {events.length === 0 ? (
            <div className="empty-state">
              <h3>No {openOnly ? "open " : ""}risk signals</h3>
            </div>
          ) : (
            <div className="table-wrap table-wrap--responsive-cards">
              <table className="table">
                <thead>
                  <tr>
                    <th>Signal</th>
                    <th>Severity</th>
                    <th>User</th>
                    <th>Recorded</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td data-label="Signal">{signalTypeLabel(event.signalType)}</td>
                      <td data-label="Severity">
                        <span className={`chip chip--${SEVERITY_TONE[event.severity]}`}>{event.severity}</span>
                      </td>
                      <td data-label="User">{event.userId}</td>
                      <td data-label="Recorded">{formatDateTime(event.createdAt)}</td>
                      <td data-label="Status">{event.reviewState === "open" ? "Open" : event.reviewState}</td>
                      <td data-label="">
                        {event.reviewState === "open" && (
                          <div style={{ display: "flex", gap: "0.5rem" }}>
                            <button
                              type="button"
                              className="button button--ghost"
                              disabled={pendingId === event.id}
                              onClick={() => void handleReview(event.id, "reviewed")}
                            >
                              Mark reviewed
                            </button>
                            <button
                              type="button"
                              className="button button--ghost"
                              disabled={pendingId === event.id}
                              onClick={() => void handleReview(event.id, "dismissed")}
                            >
                              Dismiss
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
