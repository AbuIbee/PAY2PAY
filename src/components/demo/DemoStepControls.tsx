import Link from "next/link";

/**
 * Demo navigation & dedicated demo experiences: the shared Next/Back/Exit/progress control cluster
 * required on every dedicated demo route (P2P/C2B/B2B scenarios and the Product Tour) — "Step X of Y"
 * plus Next, Back, and an Exit control that returns to the general demo landing page. Pure UI, no
 * network calls, no state of its own (the parent owns stepIndex).
 */
export function DemoStepControls({
  stepIndex,
  totalSteps,
  onNext,
  onBack,
  exitLabel = "Exit",
  lastStepHref,
  lastStepLabel,
}: {
  stepIndex: number;
  totalSteps: number;
  onNext: () => void;
  onBack: () => void;
  exitLabel?: string;
  lastStepHref?: string;
  lastStepLabel?: string;
}) {
  const isLast = stepIndex === totalSteps - 1;
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <div className="hero__actions" style={{ justifyContent: "space-between" }}>
        <Link
          href="/demo"
          style={{ color: "var(--forest-700)", fontWeight: 750, fontSize: "0.9rem" }}
        >
          {exitLabel}
        </Link>
        <span style={{ color: "var(--ink-soft)", fontSize: "0.85rem" }}>
          Step {stepIndex + 1} of {totalSteps}
        </span>
      </div>
      <div className="hero__actions">
        <button type="button" className="button button--ghost" disabled={stepIndex === 0} onClick={onBack}>
          Back
        </button>
        {isLast && lastStepHref && lastStepLabel ? (
          <Link className="button button--primary" href={lastStepHref}>
            {lastStepLabel}
          </Link>
        ) : (
          <button type="button" className="button button--primary" disabled={isLast} onClick={onNext}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}
