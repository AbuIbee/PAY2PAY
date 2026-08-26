"use client";

import Link from "next/link";
import type { AgreementProgress as AgreementProgressData, AgreementProgressStepStatus } from "@/lib/agreements/agreementProgressService";

const STATUS_META: Record<AgreementProgressStepStatus, { icon: string; text: string; tone: "success" | "info" | "warning" | "danger" | "neutral" }> = {
  complete: { icon: "✓", text: "Complete", tone: "success" },
  current: { icon: "●", text: "Current", tone: "info" },
  action_required: { icon: "⚠", text: "Action required", tone: "warning" },
  waiting: { icon: "…", text: "Waiting on other party", tone: "neutral" },
  blocked: { icon: "⛔", text: "Blocked", tone: "danger" },
  optional: { icon: "–", text: "Optional", tone: "neutral" },
  not_started: { icon: "○", text: "Not started", tone: "neutral" },
  cancelled: { icon: "✕", text: "Cancelled", tone: "neutral" },
};

/**
 * Agreement workflow remediation (Problem 3): the persistent, mobile-friendly "Agreement Progress"
 * checklist required on every relevant agreement screen. Pure rendering of server-derived state
 * (AgreementProgressService is the sole authority — see that class's own doc comment); this component
 * makes no authorization decisions and calls no mutating endpoint itself, only navigates via each
 * step's own `cta.href`. A vertical `<ol>` by design (never a horizontal desktop stepper) — reads
 * top-to-bottom with no horizontal scrolling at any viewport, and status is always conveyed by an
 * icon + text label + chip together, never by color alone.
 */
export function AgreementProgress({ data }: { data: AgreementProgressData }) {
  return (
    <div className="card" aria-labelledby="agreement-progress-heading">
      <div className="card__header">
        <h3 id="agreement-progress-heading">Agreement progress</h3>
      </div>

      {data.actionableForMeCount > 1 && (
        <p
          role="status"
          style={{
            margin: "0 0 1rem",
            padding: "0.85rem 1rem",
            borderRadius: "0.7rem",
            fontSize: "0.85rem",
            fontWeight: 700,
            background: "var(--gold-soft)",
            color: "#7a5610",
          }}
        >
          {data.actionableForMeCount} items required before this agreement can be completed
        </p>
      )}

      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "1rem" }}>
        {data.steps.map((step, index) => {
          const meta = STATUS_META[step.status];
          return (
            <li key={step.key} style={{ display: "grid", gap: "0.35rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <span aria-hidden="true">{meta.icon}</span>
                <strong>
                  Step {index + 1} — {step.label}
                </strong>
                <span className={`chip chip--${meta.tone}`}>{step.statusText ?? meta.text}</span>
              </div>
              <p style={{ margin: "0 0 0 1.6rem", color: "var(--ink-soft)", fontSize: "0.9rem" }}>{step.description}</p>
              {step.cta && (
                <div style={{ margin: "0.15rem 0 0 1.6rem" }}>
                  <Link href={step.cta.href} className="button button--ghost">
                    {step.cta.label}
                  </Link>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div style={{ marginTop: "1.25rem", paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
        <p style={{ margin: "0 0 0.6rem", fontWeight: 700 }}>
          {data.status === "mutually_canceled" ? data.primaryAction.label : `Next: ${data.primaryAction.label}`}
        </p>
        <p style={{ margin: "0 0 0.75rem", color: "var(--ink-soft)", fontSize: "0.9rem" }}>{data.primaryAction.description}</p>
        {data.primaryAction.cta && (
          <Link href={data.primaryAction.cta.href} className="button button--primary">
            {data.primaryAction.cta.label}
          </Link>
        )}
      </div>
    </div>
  );
}
