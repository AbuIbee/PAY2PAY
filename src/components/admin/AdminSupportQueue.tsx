"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatDateTime } from "@/lib/ui/date";
import { supportCaseStatusLabel } from "@/lib/ui/statusLabels";

type SupportCaseStatus = "open" | "in_review" | "resolved" | "closed";

interface SupportCaseRecord {
  id: string;
  subjectUserId: string;
  category: string | null;
  summary: string;
  status: SupportCaseStatus;
  resolutionNotes: string | null;
  createdAt: string;
}

const NEXT_STATUS: Record<SupportCaseStatus, SupportCaseStatus | null> = {
  open: "in_review",
  in_review: "resolved",
  resolved: "closed",
  closed: null,
};

export function AdminSupportQueue() {
  const [cases, setCases] = useState<SupportCaseRecord[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [actionError, setActionError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const [opening, setOpening] = useState(false);
  const [subjectUserId, setSubjectUserId] = useState("");
  const [category, setCategory] = useState("");
  const [summary, setSummary] = useState("");

  async function load() {
    try {
      const body = await apiFetch<{ cases: SupportCaseRecord[] }>("/api/admin/support-cases");
      setCases(body.cases);
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

  async function handleOpen(event: React.FormEvent) {
    event.preventDefault();
    setOpening(true);
    setActionError(null);
    try {
      await apiFetch("/api/admin/support-cases/open", {
        method: "POST",
        body: JSON.stringify({ subjectUserId, category: category.trim() || null, summary }),
      });
      setSubjectUserId("");
      setCategory("");
      setSummary("");
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong opening this case.");
    } finally {
      setOpening(false);
    }
  }

  async function handleAdvance(supportCase: SupportCaseRecord) {
    const next = NEXT_STATUS[supportCase.status];
    if (!next) return;
    setActionError(null);
    try {
      await apiFetch("/api/admin/support-cases/status", {
        method: "POST",
        body: JSON.stringify({ caseId: supportCase.id, status: next, resolutionNotes: notes[supportCase.id] ?? null }),
      });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong updating this case.");
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
          <h2>Open cases</h2>
        </div>
        {state === "loading" && (
          <div aria-hidden="true">
            <div className="skeleton skeleton--line" />
          </div>
        )}
        {state === "error" && (
          <div className="form-status form-status--error" role="alert">
            Something went wrong loading cases. Please try again.
          </div>
        )}
        {state === "ready" && cases.length === 0 && (
          <div className="empty-state">
            <h3>No open cases</h3>
          </div>
        )}
        {state === "ready" &&
          cases.map((supportCase) => {
            const label = supportCaseStatusLabel(supportCase.status);
            const next = NEXT_STATUS[supportCase.status];
            return (
              <div className="card" key={supportCase.id}>
                <div className="card__header">
                  <h3>{supportCase.summary}</h3>
                  <span className={`chip chip--${label.tone}`}>{label.label}</span>
                </div>
                <p style={{ color: "var(--ink-soft)" }}>
                  Subject: {supportCase.subjectUserId}
                  {supportCase.category ? ` · ${supportCase.category}` : ""} · opened{" "}
                  {formatDateTime(supportCase.createdAt)}
                </p>
                {next && (
                  <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
                    <div className="field" style={{ flex: 1, minWidth: "16rem" }}>
                      <label htmlFor={`notes-${supportCase.id}`}>Notes (optional)</label>
                      <input
                        id={`notes-${supportCase.id}`}
                        value={notes[supportCase.id] ?? ""}
                        onChange={(e) => setNotes((current) => ({ ...current, [supportCase.id]: e.target.value }))}
                      />
                    </div>
                    <button type="button" className="button button--primary" onClick={() => void handleAdvance(supportCase)}>
                      Move to {supportCaseStatusLabel(next).label}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
      </div>

      <div className="card">
        <div className="card__header">
          <h2>Open a new case</h2>
        </div>
        <form onSubmit={(e) => void handleOpen(e)} style={{ display: "grid", gap: "1rem", maxWidth: "28rem" }}>
          <div className="field">
            <label htmlFor="case-subject">Subject user ID</label>
            <input id="case-subject" required value={subjectUserId} onChange={(e) => setSubjectUserId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="case-category">Category (optional)</label>
            <input id="case-category" value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="case-summary">Summary</label>
            <textarea id="case-summary" required value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div>
            <button type="submit" className="button button--primary" disabled={opening}>
              {opening ? "Opening…" : "Open case"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
