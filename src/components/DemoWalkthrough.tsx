"use client";

import Link from "next/link";
import { useState } from "react";

interface DemoStep {
  title: string;
  body: string;
  heading: string;
  statusLabel: string;
  stats: { label: string; value: string }[];
  progressPercent: number;
  timelineRows: { label: string; detail: string; complete: boolean }[];
}

interface DemoScenario {
  key: string;
  tag: string;
  name: string;
  summary: string;
  steps: DemoStep[];
}

/**
 * Section R/S (closed-beta remediation, Product Owner review): a public, no-signup demo using seeded
 * fictional data only — reuses the landing page's own ProductPreview fixture-data pattern
 * (src/app/(marketing)/page.tsx) rather than the real dashboard/agreement APIs. This component makes
 * zero fetch() calls; every value below is a hardcoded string. It must never create real agreements,
 * payment methods, bank/card records, or notifications, and must never touch production customer
 * data — satisfied trivially here since nothing in this file reads or writes any backend at all.
 */
const SCENARIOS: DemoScenario[] = [
  {
    key: "p2p",
    tag: "P2P",
    name: "Personal repayment",
    summary: "Fatimah owes Aminah $1,200",
    steps: [
      {
        title: "The situation",
        body: "Fatimah borrowed $1,200 from Aminah. Instead of relying on memory and text messages, they agree to document a repayment plan on PAY2PAY.",
        heading: "Fatimah & Aminah",
        statusLabel: "Getting started",
        stats: [
          { label: "Amount owed", value: "$1,200" },
          { label: "Interest", value: "$0" },
          { label: "Parties", value: "2" },
        ],
        progressPercent: 0,
        timelineRows: [{ label: "Debt exists", detail: "Documented outside PAY2PAY until now", complete: true }],
      },
      {
        title: "Connect",
        body: "Aminah invites Fatimah to connect on PAY2PAY. Fatimah accepts the invitation.",
        heading: "Fatimah & Aminah",
        statusLabel: "Connected",
        stats: [
          { label: "Invitation", value: "Accepted" },
          { label: "Amount owed", value: "$1,200" },
          { label: "Parties", value: "2" },
        ],
        progressPercent: 0,
        timelineRows: [
          { label: "Debt exists", detail: "Documented outside PAY2PAY until now", complete: true },
          { label: "Connection accepted", detail: "Aminah invited, Fatimah accepted", complete: true },
        ],
      },
      {
        title: "Create the agreement",
        body: "Together they document the terms: $1,200 principal, repaid at $200 per month for 6 months, with no interest.",
        heading: "Repayment agreement",
        statusLabel: "Draft",
        stats: [
          { label: "Principal", value: "$1,200" },
          { label: "Monthly payment", value: "$200" },
          { label: "Term", value: "6 months" },
        ],
        progressPercent: 0,
        timelineRows: [
          { label: "Connection accepted", detail: "Aminah invited, Fatimah accepted", complete: true },
          { label: "Agreement drafted", detail: "$200/month for 6 months, no interest", complete: true },
        ],
      },
      {
        title: "Both sign",
        body: "Fatimah reviews and signs. Aminah reviews and signs. The terms are now locked and cannot be changed unilaterally.",
        heading: "Repayment agreement",
        statusLabel: "Signed",
        stats: [
          { label: "Principal", value: "$1,200" },
          { label: "Monthly payment", value: "$200" },
          { label: "Signed by", value: "Both parties" },
        ],
        progressPercent: 0,
        timelineRows: [
          { label: "Agreement drafted", detail: "$200/month for 6 months, no interest", complete: true },
          { label: "Signed", detail: "Fatimah and Aminah both signed", complete: true },
        ],
      },
      {
        title: "First payment",
        body: "The first $200 payment clears. Fatimah's remaining balance drops to $1,000.",
        heading: "Repayment agreement",
        statusLabel: "On schedule",
        stats: [
          { label: "Remaining balance", value: "$1,000" },
          { label: "Next payment", value: "$200" },
          { label: "Payments made", value: "1 of 6" },
        ],
        progressPercent: 17,
        timelineRows: [
          { label: "Signed", detail: "Fatimah and Aminah both signed", complete: true },
          { label: "Payment received", detail: "$200 cleared and recorded", complete: true },
          { label: "Next installment", detail: "$200 due next month", complete: false },
        ],
      },
    ],
  },
  {
    key: "c2b",
    tag: "C2B",
    name: "Customer payment plan",
    summary: "Jaleel pays Prestiege Apartments $2,000/mo rent",
    steps: [
      {
        title: "The situation",
        body: "Jaleel has a rental agreement with Prestiege Apartments, paying $2,000 in rent every month.",
        heading: "Jaleel & Prestiege Apartments",
        statusLabel: "Getting started",
        stats: [
          { label: "Monthly rent", value: "$2,000" },
          { label: "Frequency", value: "Monthly" },
          { label: "Parties", value: "2" },
        ],
        progressPercent: 0,
        timelineRows: [{ label: "Lease exists", detail: "Managed off-platform until now", complete: true }],
      },
      {
        title: "Connect",
        body: "Prestiege Apartments invites Jaleel to connect as a paying tenant. Jaleel accepts.",
        heading: "Jaleel & Prestiege Apartments",
        statusLabel: "Connected",
        stats: [
          { label: "Invitation", value: "Accepted" },
          { label: "Monthly rent", value: "$2,000" },
          { label: "Parties", value: "2" },
        ],
        progressPercent: 0,
        timelineRows: [
          { label: "Lease exists", detail: "Managed off-platform until now", complete: true },
          { label: "Connection accepted", detail: "Prestiege Apartments invited, Jaleel accepted", complete: true },
        ],
      },
      {
        title: "Create the agreement",
        body: "They document a C2B agreement: $2,000 due on the 1st of every month, ongoing.",
        heading: "Rent payment agreement",
        statusLabel: "Draft",
        stats: [
          { label: "Amount", value: "$2,000/mo" },
          { label: "Due date", value: "1st of month" },
          { label: "Schedule", value: "Ongoing" },
        ],
        progressPercent: 0,
        timelineRows: [
          { label: "Connection accepted", detail: "Prestiege Apartments invited, Jaleel accepted", complete: true },
          { label: "Agreement drafted", detail: "$2,000 due on the 1st, ongoing", complete: true },
        ],
      },
      {
        title: "Both sign",
        body: "Jaleel signs. Prestiege Apartments' authorized representative signs. The terms are now locked.",
        heading: "Rent payment agreement",
        statusLabel: "Signed",
        stats: [
          { label: "Amount", value: "$2,000/mo" },
          { label: "Due date", value: "1st of month" },
          { label: "Signed by", value: "Both parties" },
        ],
        progressPercent: 0,
        timelineRows: [
          { label: "Agreement drafted", detail: "$2,000 due on the 1st, ongoing", complete: true },
          { label: "Signed", detail: "Jaleel and Prestiege Apartments both signed", complete: true },
        ],
      },
      {
        title: "This month's rent",
        body: "This month's $2,000 rent payment clears. The next payment is due on the 1st of next month.",
        heading: "Rent payment agreement",
        statusLabel: "On schedule",
        stats: [
          { label: "This month", value: "Paid" },
          { label: "Next due", value: "1st of next month" },
          { label: "Payments made", value: "1" },
        ],
        progressPercent: 100,
        timelineRows: [
          { label: "Signed", detail: "Jaleel and Prestiege Apartments both signed", complete: true },
          { label: "Payment received", detail: "$2,000 cleared and recorded", complete: true },
          { label: "Next payment", detail: "$2,000 due the 1st of next month", complete: false },
        ],
      },
    ],
  },
  {
    key: "b2b",
    tag: "B2B",
    name: "Commercial receivable",
    summary: "Mary's Mechanic Shop pays Adam's Auto Parts $3,500/mo",
    steps: [
      {
        title: "The situation",
        body: "Mary's Mechanic Shop has a running tab with Adam's Auto Parts, paying $3,500 a month toward parts purchased on credit.",
        heading: "Mary's Mechanic Shop & Adam's Auto Parts",
        statusLabel: "Getting started",
        stats: [
          { label: "Monthly payment", value: "$3,500" },
          { label: "Invoice", value: "#A-1042" },
          { label: "Parties", value: "2 businesses" },
        ],
        progressPercent: 0,
        timelineRows: [{ label: "Running tab exists", detail: "Tracked off-platform until now", complete: true }],
      },
      {
        title: "Connect",
        body: "Adam's Auto Parts invites Mary's Mechanic Shop's authorized representative to connect.",
        heading: "Mary's Mechanic Shop & Adam's Auto Parts",
        statusLabel: "Connected",
        stats: [
          { label: "Invitation", value: "Accepted" },
          { label: "Monthly payment", value: "$3,500" },
          { label: "Parties", value: "2 businesses" },
        ],
        progressPercent: 0,
        timelineRows: [
          { label: "Running tab exists", detail: "Tracked off-platform until now", complete: true },
          { label: "Connection accepted", detail: "Authorized representatives connected", complete: true },
        ],
      },
      {
        title: "Create the agreement",
        body: "They document a B2B agreement: $3,500 per month, tied to invoice #A-1042, with both companies' authorized representatives on record.",
        heading: "Commercial receivable",
        statusLabel: "Draft",
        stats: [
          { label: "Amount", value: "$3,500/mo" },
          { label: "Invoice", value: "#A-1042" },
          { label: "Reps on record", value: "2" },
        ],
        progressPercent: 0,
        timelineRows: [
          { label: "Connection accepted", detail: "Authorized representatives connected", complete: true },
          { label: "Agreement drafted", detail: "$3,500/month, tied to invoice #A-1042", complete: true },
        ],
      },
      {
        title: "Both sign",
        body: "Both authorized representatives sign. The agreement is locked and tied to the original invoice.",
        heading: "Commercial receivable",
        statusLabel: "Signed",
        stats: [
          { label: "Amount", value: "$3,500/mo" },
          { label: "Invoice", value: "#A-1042" },
          { label: "Signed by", value: "Both representatives" },
        ],
        progressPercent: 0,
        timelineRows: [
          { label: "Agreement drafted", detail: "$3,500/month, tied to invoice #A-1042", complete: true },
          { label: "Signed", detail: "Both authorized representatives signed", complete: true },
        ],
      },
      {
        title: "This month's payment",
        body: "This month's $3,500 payment clears from Mary's Mechanic Shop's business account to Adam's Auto Parts.",
        heading: "Commercial receivable",
        statusLabel: "On schedule",
        stats: [
          { label: "This month", value: "Paid" },
          { label: "Invoice balance", value: "Reducing" },
          { label: "Payments made", value: "1" },
        ],
        progressPercent: 100,
        timelineRows: [
          { label: "Signed", detail: "Both authorized representatives signed", complete: true },
          { label: "Payment received", detail: "$3,500 cleared and recorded", complete: true },
          { label: "Next payment", detail: "$3,500 due next month", complete: false },
        ],
      },
    ],
  },
  {
    key: "tour",
    tag: "TOUR",
    name: "Dashboard tour",
    summary: "A guided look at your dashboard",
    steps: [
      {
        title: "Your dashboard, at a glance",
        body: "The dashboard opens with what you owe, what's owed to you, your active agreements, and anything that needs your attention.",
        heading: "Dashboard",
        statusLabel: "Overview",
        stats: [
          { label: "Money I owe", value: "$1,000" },
          { label: "Money owed to me", value: "$0" },
          { label: "Payment Arrangements", value: "2" },
        ],
        progressPercent: 0,
        timelineRows: [],
      },
      {
        title: "Pending invitations",
        body: "Connections waiting on your response show up here first, so you never miss one buried in email.",
        heading: "What requires action",
        statusLabel: "1 waiting",
        stats: [
          { label: "Pending invitations", value: "1 waiting on your response" },
          { label: "Payment Arrangements needing signature", value: "0" },
          { label: "Unread notifications", value: "3" },
        ],
        progressPercent: 0,
        timelineRows: [],
      },
      {
        title: "Payment Arrangements needing your signature",
        body: "Agreements awaiting your signature are called out separately from ones already in progress, so nothing sits unsigned by accident.",
        heading: "What requires action",
        statusLabel: "1 awaiting signature",
        stats: [
          { label: "Pending invitations", value: "0" },
          { label: "Payment Arrangements needing signature", value: "1 awaiting your signature" },
          { label: "Unread notifications", value: "3" },
        ],
        progressPercent: 0,
        timelineRows: [],
      },
      {
        title: "Notifications",
        body: "Notifications keep you posted on payments, signature requests, and account activity as they happen.",
        heading: "Notifications",
        statusLabel: "3 unread",
        stats: [
          { label: "Payment received", value: "2 hours ago" },
          { label: "Agreement signed", value: "Yesterday" },
          { label: "New invitation", value: "2 days ago" },
        ],
        progressPercent: 0,
        timelineRows: [],
      },
      {
        title: "Payment methods & Support",
        body: "Adding a bank account and reaching support are always one click away from the dashboard — never buried in a menu.",
        heading: "Quick access",
        statusLabel: "Ready",
        stats: [
          { label: "Payment methods", value: "Add or verify a bank account" },
          { label: "Support", value: "Open cases, disputes, appeals" },
          { label: "Payment Arrangements", value: "2 active" },
        ],
        progressPercent: 0,
        timelineRows: [],
      },
    ],
  },
];

function StepVisual({ step }: { step: DemoStep }) {
  return (
    <div className="preview-window" aria-hidden="true">
      <div className="preview-window__bar">
        <span />
        <span />
        <span />
        <p>{step.heading}</p>
      </div>
      <div className="preview-window__content">
        <div className="preview-sidebar">
          <div className="preview-logo">P2P</div>
          <span className="preview-nav-item preview-nav-item--active" />
          <span className="preview-nav-item" />
          <span className="preview-nav-item" />
          <span className="preview-nav-item" />
        </div>
        <div className="preview-dashboard">
          <div className="preview-dashboard__heading">
            <div>
              <span className="preview-kicker">DEMO</span>
              <h2>{step.heading}</h2>
            </div>
            <span className="status-pill">{step.statusLabel}</span>
          </div>

          <div className="preview-stats">
            {step.stats.map((stat) => (
              <div key={stat.label}>
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
              </div>
            ))}
          </div>

          {step.progressPercent > 0 && (
            <div className="preview-progress">
              <div className="preview-progress__meta">
                <span>Repayment progress</span>
                <strong>{step.progressPercent}%</strong>
              </div>
              <div className="preview-progress__track">
                <span style={{ width: `${step.progressPercent}%` }} />
              </div>
            </div>
          )}

          {step.timelineRows.length > 0 && (
            <div className="preview-timeline">
              {step.timelineRows.map((row) => (
                <div key={row.label} className={`timeline-row${row.complete ? " timeline-row--complete" : ""}`}>
                  <span className="timeline-dot" />
                  <div>
                    <strong>{row.label}</strong>
                    <small>{row.detail}</small>
                  </div>
                  <time>{row.complete ? "Done" : "Upcoming"}</time>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function DemoWalkthrough() {
  const [scenarioKey, setScenarioKey] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);

  const scenario = SCENARIOS.find((s) => s.key === scenarioKey) ?? null;
  const step = scenario?.steps[stepIndex] ?? null;

  function selectScenario(key: string) {
    setScenarioKey(key);
    setStepIndex(0);
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <div
        role="status"
        style={{
          padding: "0.85rem 1.1rem",
          borderRadius: "0.8rem",
          background: "var(--gold-soft)",
          color: "#7a5610",
          fontWeight: 750,
          fontSize: "0.85rem",
          textAlign: "center",
        }}
      >
        DEMO — No real money or accounts are being used.
      </div>

      {!scenario ? (
        <div className="relationship-grid">
          {SCENARIOS.map((s) => (
            <button
              key={s.key}
              type="button"
              className="relationship-card"
              style={{ cursor: "pointer", textAlign: "left", font: "inherit" }}
              onClick={() => selectScenario(s.key)}
            >
              <div className="relationship-card__tag">{s.tag}</div>
              <div>
                <h3>{s.name}</h3>
                <p>{s.summary}</p>
              </div>
              <span className="relationship-card__arrow" aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1.5rem" }}>
          <div className="hero__actions" style={{ justifyContent: "space-between" }}>
            <button
              type="button"
              style={{ cursor: "pointer", background: "none", border: "none", padding: 0, color: "var(--forest-700)", fontWeight: 750 }}
              onClick={() => setScenarioKey(null)}
            >
              ← Choose a different scenario
            </button>
            <span style={{ color: "var(--ink-soft)", fontSize: "0.85rem" }}>
              Step {stepIndex + 1} of {scenario.steps.length}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.8fr) minmax(20rem, 1.2fr)", gap: "3rem", alignItems: "start" }}>
            <div>
              <span className="eyebrow"><span /> {scenario.tag} — {scenario.summary}</span>
              <h2 style={{ margin: "0.8rem 0 1rem", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "1.7rem", fontWeight: 500 }}>
                {step!.title}
              </h2>
              <p style={{ margin: 0, color: "var(--ink-soft)", lineHeight: 1.7 }}>{step!.body}</p>
              <div className="hero__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={stepIndex === 0}
                  onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                >
                  Back
                </button>
                {stepIndex < scenario.steps.length - 1 ? (
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => setStepIndex((i) => Math.min(scenario.steps.length - 1, i + 1))}
                  >
                    Next
                  </button>
                ) : (
                  <Link className="button button--primary" href="/signup">
                    Create your own agreement
                  </Link>
                )}
              </div>
            </div>
            <StepVisual step={step!} />
          </div>
        </div>
      )}
    </div>
  );
}
