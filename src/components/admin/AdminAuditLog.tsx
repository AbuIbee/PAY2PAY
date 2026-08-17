"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatDateTime } from "@/lib/ui/date";

interface AuditEventRecord {
  id: number;
  actorUserId: string;
  actorRole: string;
  action: string;
  occurredAt: string;
  reason: string | null;
  targetResourceType: string | null;
  targetResourceId: string | null;
}

/** Gated on "review_audit_logs" server-side (AdminCaseReviewService.listAuditEventsForTarget). No platform-wide browse endpoint exists — always looked up by a specific target, same as restrictions. */
export function AdminAuditLog() {
  const [targetResourceType, setTargetResourceType] = useState("agreement");
  const [targetResourceId, setTargetResourceId] = useState("");
  const [events, setEvents] = useState<AuditEventRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (!targetResourceId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const body = await apiFetch<{ events: AuditEventRecord[] }>(
        `/api/admin/review/audit-log?targetResourceType=${encodeURIComponent(targetResourceType)}&targetResourceId=${encodeURIComponent(targetResourceId)}`,
      );
      setEvents(body.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong loading the audit log.");
      setEvents(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="card">
        <div className="card__header">
          <h2>Look up audit trail</h2>
        </div>
        <form onSubmit={(e) => void search(e)} style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field">
            <label htmlFor="audit-target-type">Target type</label>
            <select id="audit-target-type" value={targetResourceType} onChange={(e) => setTargetResourceType(e.target.value)}>
              <option value="agreement">Agreement</option>
              <option value="user_account">User account</option>
              <option value="business_profile">Business profile</option>
              <option value="support_case">Support case</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: "16rem" }}>
            <label htmlFor="audit-target-id">Target ID</label>
            <input id="audit-target-id" required value={targetResourceId} onChange={(e) => setTargetResourceId(e.target.value)} />
          </div>
          <button type="submit" className="button button--primary" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </form>
      </div>

      {error && (
        <div className="form-status form-status--error" role="alert" style={{ marginTop: "1rem" }}>
          {error}
        </div>
      )}

      {events && (
        <div className="card">
          <div className="card__header">
            <h2>Audit trail</h2>
          </div>
          {events.length === 0 ? (
            <div className="empty-state">
              <h3>No audit events found</h3>
            </div>
          ) : (
            <div className="table-wrap table-wrap--responsive-cards">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Target</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td data-label="When">{formatDateTime(event.occurredAt)}</td>
                      <td data-label="Action">{event.action}</td>
                      <td data-label="Actor">
                        {event.actorUserId} ({event.actorRole})
                      </td>
                      <td data-label="Target">
                        {event.targetResourceType ?? "—"}
                        {event.targetResourceId ? ` (${event.targetResourceId})` : ""}
                      </td>
                      <td data-label="Reason">{event.reason ?? "—"}</td>
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
