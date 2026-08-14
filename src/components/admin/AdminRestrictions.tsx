"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatDateTime } from "@/lib/ui/date";
import { adminRestrictionTypeLabel } from "@/lib/ui/statusLabels";

type RestrictionType = "payment_activity" | "new_agreement_creation" | "payout";

interface RestrictionRecord {
  id: string;
  restrictionType: RestrictionType;
  targetResourceType: string;
  targetResourceId: string;
  reason: string;
  caseReference: string | null;
  placedByUserId: string;
  placedAt: string;
  liftedByUserId: string | null;
  liftedAt: string | null;
}

const RESTRICTION_TYPES: RestrictionType[] = ["payment_activity", "new_agreement_creation", "payout"];

/**
 * Sprint 18B / Sprint 18: AdminRestrictionService.listForTarget has no
 * platform-wide "list all restrictions" method (verified against
 * src/app/api/admin/restrictions/route.ts) — restrictions are always looked
 * up for one known target, so this is a lookup tool, not a browsable queue.
 */
export function AdminRestrictions() {
  const [targetResourceType, setTargetResourceType] = useState("user_account");
  const [targetResourceId, setTargetResourceId] = useState("");
  const [restrictions, setRestrictions] = useState<RestrictionRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [placing, setPlacing] = useState(false);
  const [placeType, setPlaceType] = useState<RestrictionType>("payment_activity");
  const [reason, setReason] = useState("");
  const [caseReference, setCaseReference] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  async function search(event?: React.FormEvent) {
    event?.preventDefault();
    if (!targetResourceId.trim()) return;
    setLoading(true);
    setLoadError(null);
    try {
      const body = await apiFetch<{ restrictions: RestrictionRecord[] }>(
        `/api/admin/restrictions?targetResourceType=${encodeURIComponent(targetResourceType)}&targetResourceId=${encodeURIComponent(targetResourceId)}`,
      );
      setRestrictions(body.restrictions);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Something went wrong looking up restrictions.");
      setRestrictions(null);
    } finally {
      setLoading(false);
    }
  }

  async function handlePlace(event: React.FormEvent) {
    event.preventDefault();
    setPlacing(true);
    setActionError(null);
    try {
      await apiFetch("/api/admin/restrictions/place", {
        method: "POST",
        body: JSON.stringify({
          restrictionType: placeType,
          targetResourceType,
          targetResourceId,
          reason,
          caseReference: caseReference.trim() || null,
        }),
      });
      setReason("");
      setCaseReference("");
      await search();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong placing this restriction.");
    } finally {
      setPlacing(false);
    }
  }

  async function handleLift(restrictionId: string) {
    setActionError(null);
    try {
      await apiFetch("/api/admin/restrictions/lift", { method: "POST", body: JSON.stringify({ restrictionId }) });
      await search();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong lifting this restriction.");
    }
  }

  return (
    <div>
      <div className="card">
        <div className="card__header">
          <h2>Look up restrictions</h2>
        </div>
        <form onSubmit={(e) => void search(e)} style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field">
            <label htmlFor="restriction-target-type">Target type</label>
            <select id="restriction-target-type" value={targetResourceType} onChange={(e) => setTargetResourceType(e.target.value)}>
              <option value="user_account">User account</option>
              <option value="business_profile">Business profile</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: "16rem" }}>
            <label htmlFor="restriction-target-id">Target ID</label>
            <input id="restriction-target-id" required value={targetResourceId} onChange={(e) => setTargetResourceId(e.target.value)} />
          </div>
          <button type="submit" className="button button--primary" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </form>
      </div>

      {loadError && (
        <div className="form-status form-status--error" role="alert" style={{ marginTop: "1rem" }}>
          {loadError}
        </div>
      )}

      {restrictions && (
        <div className="card">
          <div className="card__header">
            <h2>Restrictions for this target</h2>
          </div>
          {restrictions.length === 0 ? (
            <div className="empty-state">
              <h3>No restrictions found</h3>
            </div>
          ) : (
            <div className="table-wrap table-wrap--responsive-cards">
              <table className="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Reason</th>
                    <th>Placed</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {restrictions.map((r) => {
                    const label = adminRestrictionTypeLabel(r.restrictionType);
                    const active = !r.liftedAt;
                    return (
                      <tr key={r.id}>
                        <td data-label="Type">
                          <span className={`chip chip--${active ? label.tone : "neutral"}`}>{label.label}</span>
                        </td>
                        <td data-label="Reason">{r.reason}</td>
                        <td data-label="Placed">{formatDateTime(r.placedAt)}</td>
                        <td data-label="Status">{active ? "Active" : `Lifted ${formatDateTime(r.liftedAt as string)}`}</td>
                        <td data-label="">
                          {active && (
                            <button type="button" className="button button--ghost" onClick={() => void handleLift(r.id)}>
                              Lift
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="card__header" style={{ marginTop: "1.5rem" }}>
            <h3>Place a new restriction</h3>
          </div>
          <form onSubmit={(e) => void handlePlace(e)} style={{ display: "grid", gap: "1rem", maxWidth: "28rem" }}>
            <div className="field">
              <label htmlFor="place-restriction-type">Restriction type</label>
              <select id="place-restriction-type" value={placeType} onChange={(e) => setPlaceType(e.target.value as RestrictionType)}>
                {RESTRICTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {adminRestrictionTypeLabel(t).label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="place-reason">Reason</label>
              <textarea id="place-reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="place-case-reference">Case reference (optional)</label>
              <input id="place-case-reference" value={caseReference} onChange={(e) => setCaseReference(e.target.value)} />
            </div>
            {actionError && (
              <p className="field-error" role="alert">
                {actionError}
              </p>
            )}
            <div className="confirm-banner">
              This immediately restricts the account&apos;s activity. Confirm the reason above before placing it.
            </div>
            <div>
              <button type="submit" className="button button--primary" disabled={placing}>
                {placing ? "Placing…" : "Place restriction"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
