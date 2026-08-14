"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatDateTime } from "@/lib/ui/date";
import { retentionHoldTypeLabel } from "@/lib/ui/statusLabels";

type HoldType = "retention" | "dispute" | "fraud_review" | "litigation" | "administrative_override";

interface RetentionHoldRecord {
  id: string;
  targetResourceType: string;
  targetResourceId: string;
  holdType: HoldType;
  reason: string;
  placedByUserId: string;
  placedAt: string;
  releasedByUserId: string | null;
  releasedAt: string | null;
}

const HOLD_TYPES: HoldType[] = ["retention", "dispute", "fraud_review", "litigation", "administrative_override"];

export function AdminRetentionHolds() {
  const [holds, setHolds] = useState<RetentionHoldRecord[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [actionError, setActionError] = useState<string | null>(null);

  const [placing, setPlacing] = useState(false);
  const [targetResourceType, setTargetResourceType] = useState("agreement");
  const [targetResourceId, setTargetResourceId] = useState("");
  const [holdType, setHoldType] = useState<HoldType>("retention");
  const [reason, setReason] = useState("");

  async function load() {
    try {
      const body = await apiFetch<{ holds: RetentionHoldRecord[] }>("/api/admin/retention/holds");
      setHolds(body.holds);
      setState("ready");
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, []);

  async function handlePlace(event: React.FormEvent) {
    event.preventDefault();
    setPlacing(true);
    setActionError(null);
    try {
      await apiFetch("/api/admin/retention/holds/place", {
        method: "POST",
        body: JSON.stringify({ targetResourceType, targetResourceId, holdType, reason }),
      });
      setTargetResourceId("");
      setReason("");
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong placing this hold.");
    } finally {
      setPlacing(false);
    }
  }

  async function handleRelease(holdId: string) {
    setActionError(null);
    try {
      await apiFetch("/api/admin/retention/holds/release", { method: "POST", body: JSON.stringify({ holdId }) });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong releasing this hold.");
    }
  }

  return (
    <div>
      <div className="card">
        <div className="card__header">
          <h2>Active legal &amp; retention holds</h2>
        </div>
        {state === "loading" && (
          <div aria-hidden="true">
            <div className="skeleton skeleton--line" />
            <div className="skeleton skeleton--line" />
          </div>
        )}
        {state === "error" && (
          <div className="form-status form-status--error" role="alert">
            Something went wrong loading holds. Please try again.
          </div>
        )}
        {state === "ready" && holds.length === 0 && (
          <div className="empty-state">
            <h3>No active holds</h3>
          </div>
        )}
        {state === "ready" && holds.length > 0 && (
          <div className="table-wrap table-wrap--responsive-cards">
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Target</th>
                  <th>Reason</th>
                  <th>Placed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {holds.map((hold) => {
                  const label = retentionHoldTypeLabel(hold.holdType);
                  return (
                    <tr key={hold.id}>
                      <td data-label="Type">
                        <span className={`chip chip--${label.tone}`}>{label.label}</span>
                      </td>
                      <td data-label="Target">
                        {hold.targetResourceType} / {hold.targetResourceId}
                      </td>
                      <td data-label="Reason">{hold.reason}</td>
                      <td data-label="Placed">{formatDateTime(hold.placedAt)}</td>
                      <td data-label="">
                        <button type="button" className="button button--ghost" onClick={() => void handleRelease(hold.id)}>
                          Release
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card__header">
          <h2>Place a new hold</h2>
        </div>
        <form onSubmit={(e) => void handlePlace(e)} style={{ display: "grid", gap: "1rem", maxWidth: "28rem" }}>
          <div className="field">
            <label htmlFor="hold-target-type">Target type</label>
            <select id="hold-target-type" value={targetResourceType} onChange={(e) => setTargetResourceType(e.target.value)}>
              <option value="agreement">Agreement</option>
              <option value="user_account">User account</option>
              <option value="business_profile">Business profile</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="hold-target-id">Target ID</label>
            <input id="hold-target-id" required value={targetResourceId} onChange={(e) => setTargetResourceId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="hold-type">Hold type</label>
            <select id="hold-type" value={holdType} onChange={(e) => setHoldType(e.target.value as HoldType)}>
              {HOLD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {retentionHoldTypeLabel(t).label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="hold-reason">Reason</label>
            <textarea id="hold-reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {actionError && (
            <p className="field-error" role="alert">
              {actionError}
            </p>
          )}
          <div className="confirm-banner">
            A retention hold blocks scheduled deletion for this target until released.
          </div>
          <div>
            <button type="submit" className="button button--primary" disabled={placing}>
              {placing ? "Placing…" : "Place hold"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
