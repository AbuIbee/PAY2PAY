"use client";

import { useState } from "react";
import { DemoBanner } from "./DemoBanner";
import { DemoStepControls } from "./DemoStepControls";

interface Step {
  title: string;
  body: string;
  stats: { label: string; value: string }[];
}

/**
 * Demo navigation & dedicated demo experiences (Product Owner request): B2B Demo — Business A owes
 * Business B $5,000 on an agreed repayment plan, including an explicit "authorized staff/role
 * context" step (a business acts through authorized representatives, not the business itself).
 * Fixture data only, no network calls.
 */
const STEPS: Step[] = [
  {
    title: "The situation",
    body: "Cedar Point Builders owes Summit Supply Co. $5,000 for materials purchased on a trade account. Both companies agree to document a formal repayment plan on PAY2PAY.",
    stats: [
      { label: "Amount owed", value: "$5,000" },
      { label: "Business A (owes)", value: "Cedar Point Builders" },
      { label: "Business B (owed)", value: "Summit Supply Co." },
    ],
  },
  {
    title: "Business relationship",
    body: "Summit Supply Co. invites Cedar Point Builders to connect as a business-to-business relationship. Cedar Point Builders accepts.",
    stats: [
      { label: "Invitation", value: "Accepted" },
      { label: "Connection", value: "Active" },
      { label: "Amount", value: "$5,000" },
    ],
  },
  {
    title: "Authorized staff & role context",
    body: "A business never acts on its own — every action is taken by a specific authorized person. Here, Cedar Point Builders' office manager and Summit Supply Co.'s accounts-receivable lead are the staff members authorized to act for their companies on this agreement.",
    stats: [
      { label: "Acting for Cedar Point Builders", value: "Office manager" },
      { label: "Acting for Summit Supply Co.", value: "AR lead" },
      { label: "Authorization", value: "Confirmed" },
    ],
  },
  {
    title: "Agreement",
    body: "The terms are drafted: $5,000 principal, repaid in $1,000 installments over 5 months, tied to invoice #CS-4471.",
    stats: [
      { label: "Principal", value: "$5,000" },
      { label: "Installment", value: "$1,000" },
      { label: "Agreement status", value: "Draft" },
    ],
  },
  {
    title: "Approval & signing",
    body: "Both authorized representatives review and sign. The agreement is now locked and tied to the original invoice.",
    stats: [
      { label: "Signed by", value: "Both representatives" },
      { label: "Invoice", value: "#CS-4471" },
      { label: "Agreement status", value: "Signed" },
    ],
  },
  {
    title: "Payment method",
    body: "Cedar Point Builders connects its business bank account to fund payments. Summit Supply Co. connects its business account to receive them.",
    stats: [
      { label: "Funding account", value: "Connected" },
      { label: "Payout account", value: "Connected" },
      { label: "Relationship status", value: "Active" },
    ],
  },
  {
    title: "Scheduled payments & remaining balance",
    body: "The first two $1,000 payments clear on schedule. The remaining balance drops from $5,000 to $3,000.",
    stats: [
      { label: "Payments made", value: "2 of 5" },
      { label: "Remaining balance", value: "$3,000" },
      { label: "Total paid", value: "$2,000" },
    ],
  },
  {
    title: "Completion",
    body: "After the remaining three payments clear on schedule, the full $5,000 is repaid. The agreement, signatures, and full payment history remain on record for both companies.",
    stats: [
      { label: "Remaining balance", value: "$0" },
      { label: "Total paid", value: "$5,000" },
      { label: "Agreement status", value: "Paid in full" },
    ],
  },
];

export function B2BDemo() {
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex]!;

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <DemoBanner />
      <div>
        <span className="eyebrow"><span /> B2B Demo — Business A owes Business B $5,000</span>
        <h2 style={{ margin: "0.8rem 0 1rem", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "1.7rem", fontWeight: 500 }}>
          {step.title}
        </h2>
        <p style={{ margin: 0, color: "var(--ink-soft)", lineHeight: 1.7 }}>{step.body}</p>
        <div className="preview-stats" style={{ marginTop: "1.25rem" }}>
          {step.stats.map((stat) => (
            <div key={stat.label}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
            </div>
          ))}
        </div>
      </div>
      <DemoStepControls
        stepIndex={stepIndex}
        totalSteps={STEPS.length}
        onBack={() => setStepIndex((i) => Math.max(0, i - 1))}
        onNext={() => setStepIndex((i) => Math.min(STEPS.length - 1, i + 1))}
        exitLabel="← All demos"
        lastStepHref="/demo"
        lastStepLabel="Try another demo"
      />
    </div>
  );
}
