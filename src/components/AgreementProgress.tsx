"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AgreementProgressCta, AgreementProgress as AgreementProgressData, AgreementProgressStepStatus } from "@/lib/agreements/agreementProgressService";

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
 * Fix the "Make payment" button (mandatory command): a CTA whose href is `<this same page>#anchor`
 * (every in-page CTA this component renders, e.g. "Make payment" -> `#make-payment`) is unreliable as
 * a plain `next/link` click — Next.js's client-side router can treat a same-pathname, hash-only
 * transition as a no-op and skip the browser's native hash-scroll behavior entirely, which reads as
 * "the button does nothing" (confirmed reachable on mobile). Scrolling the target into view directly
 * via the DOM sidesteps the router altogether and works identically on desktop and mobile. Falls back
 * to a normal navigation (also handling a genuinely different page) when either the hash is absent or
 * scrolling to it isn't possible (no matching pathname, or — defensively — no matching element).
 */
function ProgressCtaLink({ cta, className, pathname }: { cta: AgreementProgressCta; className: string; pathname: string | null }) {
  const [beforeHash, hash] = cta.href.split("#");
  const path = beforeHash?.split("?")[0]; // usePathname() never includes the query string.
  function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!hash || path !== pathname) return; // different page (or no anchor) — let the normal <Link> navigation happen.
    const target = document.getElementById(hash);
    if (!target) return; // defensive: fall back to normal navigation if the anchor truly isn't on the page.
    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return (
    <Link href={cta.href} className={className} onClick={handleClick}>
      {cta.label}
    </Link>
  );
}

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
  const pathname = usePathname();
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
                  <ProgressCtaLink cta={step.cta} className="button button--ghost" pathname={pathname} />
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
          <ProgressCtaLink cta={data.primaryAction.cta} className="button button--primary" pathname={pathname} />
        )}
      </div>
    </div>
  );
}
