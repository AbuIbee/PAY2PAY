"use client";

import { useState } from "react";
import { DemoBanner } from "./DemoBanner";
import { DemoStepControls } from "./DemoStepControls";

interface Step {
  title: string;
  body: string;
  roleNote?: string;
  stats: { label: string; value: string }[];
}

/**
 * Demo navigation & dedicated demo experiences (Product Owner request): C2B Demo — a customer owing
 * a local service business $600, with an explicit customer-vs-business role callout on the steps
 * where that distinction matters most. Fixture data only, no network calls.
 */
const STEPS: Step[] = [
  {
    title: "The situation",
    body: "Maya had her car serviced at Riverside Auto Repair. The $600 bill is more than she can pay all at once, so Riverside offers to document a payment plan on PAY2PAY instead of sending it to collections.",
    roleNote: "Customer's role: Maya owes the money and will make payments. Business's role: Riverside Auto Repair is owed the money and receives payments.",
    stats: [
      { label: "Amount owed", value: "$600" },
      { label: "Customer", value: "Maya" },
      { label: "Business", value: "Riverside Auto Repair" },
    ],
  },
  {
    title: "Business/customer relationship",
    body: "Riverside Auto Repair invites Maya to connect on PAY2PAY as a paying customer. Maya accepts.",
    stats: [
      { label: "Invitation", value: "Accepted" },
      { label: "Connection", value: "Active" },
      { label: "Amount", value: "$600" },
    ],
  },
  {
    title: "Repayment agreement",
    body: "They document the terms: $600 total, repaid at $150 every two weeks until paid off.",
    roleNote: "Customer's role: reviews and agrees to the terms. Business's role: an authorized representative drafts and proposes the terms.",
    stats: [
      { label: "Total owed", value: "$600" },
      { label: "Installment", value: "$150" },
      { label: "Agreement status", value: "Draft" },
    ],
  },
  {
    title: "Payment schedule",
    body: "The schedule is set: 4 payments of $150, one every two weeks, starting after both parties sign.",
    stats: [
      { label: "Payments", value: "4" },
      { label: "Frequency", value: "Every 2 weeks" },
      { label: "Agreement status", value: "Signed" },
    ],
  },
  {
    title: "Payment method",
    body: "Maya connects a bank account to fund her payments. Riverside Auto Repair connects a business account to receive them.",
    roleNote: "Customer's role: connects the funding account payments come from. Business's role: connects the payout account payments go to.",
    stats: [
      { label: "Funding account", value: "Connected" },
      { label: "Payout account", value: "Connected" },
      { label: "Relationship status", value: "Active" },
    ],
  },
  {
    title: "Payment & balance reduction",
    body: "The first $150 payment clears. The remaining balance drops from $600 to $450, and the next payment is scheduled automatically.",
    stats: [
      { label: "Payment", value: "$150" },
      { label: "Remaining balance", value: "$450" },
      { label: "Payments made", value: "1 of 4" },
    ],
  },
  {
    title: "Completion",
    body: "After the remaining three payments clear on schedule, the full $600 is repaid and the agreement is marked paid in full — with a clear record for both Maya and Riverside Auto Repair.",
    stats: [
      { label: "Remaining balance", value: "$0" },
      { label: "Total paid", value: "$600" },
      { label: "Agreement status", value: "Paid in full" },
    ],
  },
];

export function C2BDemo() {
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex]!;

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <DemoBanner />
      <div>
        <span className="eyebrow"><span /> C2B Demo — Customer owes a local business $600</span>
        <h2 style={{ margin: "0.8rem 0 1rem", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "1.7rem", fontWeight: 500 }}>
          {step.title}
        </h2>
        <p style={{ margin: 0, color: "var(--ink-soft)", lineHeight: 1.7 }}>{step.body}</p>
        {step.roleNote && (
          <p style={{ margin: "0.75rem 0 0", padding: "0.75rem 1rem", background: "var(--forest-50)", borderRadius: "0.6rem", fontSize: "0.85rem", color: "var(--ink-soft)" }}>
            {step.roleNote}
          </p>
        )}
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
