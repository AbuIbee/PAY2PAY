"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatDateTime } from "@/lib/ui/date";
import { appealStatusLabel, appealDecisionLabel } from "@/lib/ui/statusLabels";

interface AppealRecord {
  id: string;
  targetResourceType: string;
  targetResourceId: string;
  originalDecisionSummary: string;
  evidenceDescription: string | null;
  status: "submitted" | "under_review" | "decided";
  decision: "upheld" | "overturned" | "partially_overturned" | null;
  rationale: string | null;
  decidedAt: string | null;
  createdAt: string;
}

type LoadState = "loading" | "ready" | "error";

/**
 * Sprint 18B: replaces the stale pre-launch placeholder that used to live at
 * /support. There is no self-service "support case" backend today — every
 * SupportCaseService method requires the "manage_support_case" admin
 * capability, and no route lets a normal user list or open their own case
 * (see docs/SPRINT_18B_UI_INTEGRATION_MATRIX.md's Sprint 18 section) — so
 * this deliberately does not fabricate a case list/detail UI against an API
 * that doesn't exist. What IS real and user-facing: appealing a decision
 * (GET /api/appeals, POST /api/appeals/submit), which this renders in full.
 */
export function SupportAppeals() {
  const [state, setState] = useState<LoadState>("loading");
  const [appeals, setAppeals] = useState<AppealRecord[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [targetResourceType, setTargetResourceType] = useState("admin_restriction");
  const [targetResourceId, setTargetResourceId] = useState("");
  const [originalDecisionSummary, setOriginalDecisionSummary] = useState("");
  const [evidenceDescription, setEvidenceDescription] = useState("");

  async function load() {
    try {
      const body = await apiFetch<{ appeals: AppealRecord[] }>("/api/appeals");
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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiFetch("/api/appeals/submit", {
        method: "POST",
        body: JSON.stringify({
          targetResourceType,
          targetResourceId,
          originalDecisionSummary,
          evidenceDescription: evidenceDescription.trim() || null,
        }),
      });
      setShowForm(false);
      setTargetResourceId("");
      setOriginalDecisionSummary("");
      setEvidenceDescription("");
      await load();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Something went wrong submitting your appeal.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="card">
        <div className="card__header">
          <h2>Need help?</h2>
        </div>
        <p style={{ margin: 0, color: "var(--ink-soft)" }}>
          For account, agreement, or payment questions, email{" "}
          <a href="mailto:support@pay2pay.com">support@pay2pay.com</a> and our team will follow up.
          If you&apos;re appealing a specific decision made against your account (a restriction,
          suspension, or dispute outcome), use the form below instead — appeals are reviewed by
          someone independent of the original decision.
        </p>
      </div>

      <div className="card">
        <div className="card__header">
          <h2>Your appeals</h2>
          <button type="button" className="button button--primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "Submit an appeal"}
          </button>
        </div>

        {showForm && (
          <form onSubmit={(e) => void handleSubmit(e)} style={{ marginBottom: "1.5rem", display: "grid", gap: "1rem" }}>
            <div className="field">
              <label htmlFor="appeal-target-type">What are you appealing?</label>
              <select id="appeal-target-type" value={targetResourceType} onChange={(e) => setTargetResourceType(e.target.value)}>
                <option value="admin_restriction">An account restriction</option>
                <option value="support_case">A support case decision</option>
                <option value="agreement_dispute">An agreement dispute resolution</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="appeal-target-id">Reference ID</label>
              <small>The ID of the restriction, case, or dispute you&apos;re appealing.</small>
              <input
                id="appeal-target-id"
                required
                value={targetResourceId}
                onChange={(e) => setTargetResourceId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </div>
            <div className="field">
              <label htmlFor="appeal-summary">Summary of the original decision</label>
              <textarea
                id="appeal-summary"
                required
                value={originalDecisionSummary}
                onChange={(e) => setOriginalDecisionSummary(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="appeal-evidence">Additional context (optional)</label>
              <textarea id="appeal-evidence" value={evidenceDescription} onChange={(e) => setEvidenceDescription(e.target.value)} />
            </div>
            {submitError && (
              <p className="field-error" role="alert">
                {submitError}
              </p>
            )}
            <div>
              <button type="submit" className="button button--primary" disabled={submitting}>
                {submitting ? "Submitting…" : "Submit appeal"}
              </button>
            </div>
          </form>
        )}

        {state === "loading" && (
          <div aria-hidden="true">
            <div className="skeleton skeleton--line" />
            <div className="skeleton skeleton--line" />
          </div>
        )}

        {state === "error" && (
          <div className="form-status form-status--error" role="alert">
            Something went wrong loading your appeals. Please try again.
          </div>
        )}

        {state === "ready" && appeals.length === 0 && (
          <div className="empty-state">
            <h3>No appeals yet</h3>
            <p>If you believe a decision on your account was made in error, you can appeal it above.</p>
          </div>
        )}

        {state === "ready" && appeals.length > 0 && (
          <div className="table-wrap table-wrap--responsive-cards">
            <table className="table">
              <thead>
                <tr>
                  <th>Submitted</th>
                  <th>Summary</th>
                  <th>Status</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {appeals.map((appeal) => {
                  const status = appealStatusLabel(appeal.status);
                  const decision = appeal.decision ? appealDecisionLabel(appeal.decision) : null;
                  return (
                    <tr key={appeal.id}>
                      <td data-label="Submitted">{formatDateTime(appeal.createdAt)}</td>
                      <td data-label="Summary">{appeal.originalDecisionSummary}</td>
                      <td data-label="Status">
                        <span className={`chip chip--${status.tone}`}>{status.label}</span>
                      </td>
                      <td data-label="Decision">
                        {decision ? (
                          <span className={`chip chip--${decision.tone}`}>{decision.label}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
