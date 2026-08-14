"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatDateTime } from "@/lib/ui/date";
import { appealStatusLabel } from "@/lib/ui/statusLabels";

type AppealStatus = "submitted" | "under_review" | "decided";
type AppealDecision = "upheld" | "overturned" | "partially_overturned";

interface AppealRecord {
  id: string;
  appealingUserId: string;
  targetResourceType: string;
  targetResourceId: string;
  originalDecisionSummary: string;
  originalDecisionByUserId: string | null;
  evidenceDescription: string | null;
  status: AppealStatus;
  reviewerUserId: string | null;
  decision: AppealDecision | null;
  rationale: string | null;
  createdAt: string;
}

/**
 * Sprint 18B / Sprint 18 §30: "the original decision-maker may not be the
 * sole appeal reviewer" is a DB CHECK constraint
 * (appeal_reviewer_not_original_decision_maker) and re-enforced in
 * AppealService.assignReviewer. This UI enforces the same rule client-side
 * (blocking the obviously-wrong case before a round trip) while still
 * surfacing the backend's own rejection safely if it occurs. There is no
 * "list admins with manage_appeal" endpoint in this codebase (checked
 * src/app/api/admin/roles — assign/revoke only, no list) so the reviewer is
 * entered by user ID rather than picked from a directory; this is a real,
 * flagged backend gap, not a UI shortcut.
 */
export function AdminAppeals() {
  const [appeals, setAppeals] = useState<AppealRecord[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [reviewerInputs, setReviewerInputs] = useState<Record<string, string>>({});
  const [decisionState, setDecisionState] = useState<Record<string, { decision: AppealDecision; rationale: string }>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  async function load() {
    try {
      const body = await apiFetch<{ appeals: AppealRecord[] }>("/api/admin/appeals");
      setAppeals(body.appeals);
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

  async function handleAssign(appeal: AppealRecord) {
    const reviewerUserId = (reviewerInputs[appeal.id] ?? "").trim();
    setActionError(null);
    if (!reviewerUserId) return;
    if (appeal.originalDecisionByUserId && reviewerUserId === appeal.originalDecisionByUserId) {
      setActionError("The original decision-maker cannot be assigned as this appeal's reviewer.");
      return;
    }
    try {
      await apiFetch("/api/admin/appeals/assign", {
        method: "POST",
        body: JSON.stringify({ appealId: appeal.id, reviewerUserId }),
      });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong assigning a reviewer.");
    }
  }

  async function handleDecide(appeal: AppealRecord) {
    const entry = decisionState[appeal.id];
    if (!entry || !entry.rationale.trim()) return;
    setActionError(null);
    try {
      await apiFetch("/api/admin/appeals/decide", {
        method: "POST",
        body: JSON.stringify({ appealId: appeal.id, decision: entry.decision, rationale: entry.rationale }),
      });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong recording this decision.");
    }
  }

  if (state === "loading") {
    return (
      <div aria-hidden="true">
        <div className="skeleton skeleton--card" />
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="form-status form-status--error" role="alert">
        Something went wrong loading appeals. Please try again.
      </div>
    );
  }
  if (appeals.length === 0) {
    return (
      <div className="empty-state">
        <h3>No open appeals</h3>
      </div>
    );
  }

  return (
    <div>
      {actionError && (
        <div className="form-status form-status--error" role="alert" style={{ marginBottom: "1rem" }}>
          {actionError}
        </div>
      )}
      {appeals.map((appeal) => {
        const status = appealStatusLabel(appeal.status);
        const decision = decisionState[appeal.id] ?? { decision: "upheld" as AppealDecision, rationale: "" };
        return (
          <div className="card" key={appeal.id}>
            <div className="card__header">
              <h3>{appeal.originalDecisionSummary}</h3>
              <span className={`chip chip--${status.tone}`}>{status.label}</span>
            </div>
            <p style={{ color: "var(--ink-soft)" }}>
              {appeal.targetResourceType} / {appeal.targetResourceId} — submitted {formatDateTime(appeal.createdAt)}
            </p>
            {appeal.evidenceDescription && <p>{appeal.evidenceDescription}</p>}

            {!appeal.reviewerUserId && (() => {
              const enteredReviewerId = (reviewerInputs[appeal.id] ?? "").trim();
              const isSelfAssignAttempt =
                !!appeal.originalDecisionByUserId && enteredReviewerId === appeal.originalDecisionByUserId;
              return (
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div className="field" style={{ flex: 1, minWidth: "16rem" }}>
                    <label htmlFor={`reviewer-${appeal.id}`}>Assign reviewer (user ID)</label>
                    <small>Must be different from the original decision-maker.</small>
                    <input
                      id={`reviewer-${appeal.id}`}
                      value={reviewerInputs[appeal.id] ?? ""}
                      onChange={(e) => setReviewerInputs((current) => ({ ...current, [appeal.id]: e.target.value }))}
                      aria-invalid={isSelfAssignAttempt}
                    />
                    {isSelfAssignAttempt && (
                      <p className="field-error" role="alert">
                        This is the original decision-maker — pick a different reviewer.
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={!enteredReviewerId || isSelfAssignAttempt}
                    onClick={() => void handleAssign(appeal)}
                  >
                    Assign
                  </button>
                </div>
              );
            })()}

            {appeal.reviewerUserId && appeal.status !== "decided" && (
              <div style={{ display: "grid", gap: "0.75rem", marginTop: "0.75rem" }}>
                <div className="field">
                  <label htmlFor={`decision-${appeal.id}`}>Decision</label>
                  <select
                    id={`decision-${appeal.id}`}
                    value={decision.decision}
                    onChange={(e) =>
                      setDecisionState((current) => ({
                        ...current,
                        [appeal.id]: { ...decision, decision: e.target.value as AppealDecision },
                      }))
                    }
                  >
                    <option value="upheld">Upheld</option>
                    <option value="overturned">Overturned</option>
                    <option value="partially_overturned">Partially overturned</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`rationale-${appeal.id}`}>Rationale</label>
                  <textarea
                    id={`rationale-${appeal.id}`}
                    required
                    value={decision.rationale}
                    onChange={(e) =>
                      setDecisionState((current) => ({ ...current, [appeal.id]: { ...decision, rationale: e.target.value } }))
                    }
                  />
                </div>
                <div>
                  <button type="button" className="button button--primary" onClick={() => void handleDecide(appeal)}>
                    Record decision
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
