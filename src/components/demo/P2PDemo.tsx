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
 * Demo navigation & dedicated demo experiences (Product Owner request): P2P Demo — "Person A owes
 * Person B $1,000," walking the full connection → agreement → verification → signing → payment
 * method → partial payment → subsequent payments → paid-in-full journey. Fixture data only, no
 * network calls, mirrors DemoWalkthrough.tsx's own "makes zero fetch() calls" contract exactly.
 */
const STEPS: Step[] = [
  {
    title: "The situation",
    body: "Person A owes Person B $1,000. Instead of tracking it informally, they agree to document the repayment on PAY2PAY.",
    stats: [
      { label: "Amount owed", value: "$1,000" },
      { label: "Debtor", value: "Person A" },
      { label: "Creditor", value: "Person B" },
    ],
  },
  {
    title: "Connection invitation",
    body: "Person A sends Person B a connection invitation on PAY2PAY, proposing to formalize the $1,000 they're owed.",
    stats: [
      { label: "Invitation", value: "Sent" },
      { label: "Amount", value: "$1,000" },
      { label: "Status", value: "Awaiting response" },
    ],
  },
  {
    title: "Acceptance",
    body: "Person B reviews and accepts the invitation. The two are now connected on PAY2PAY.",
    stats: [
      { label: "Invitation", value: "Accepted" },
      { label: "Connection", value: "Active" },
      { label: "Amount", value: "$1,000" },
    ],
  },
  {
    title: "Repayment agreement",
    body: "Together they draft the terms: $1,000 principal, repaid in $250 installments, no interest.",
    stats: [
      { label: "Principal", value: "$1,000" },
      { label: "Installment", value: "$250" },
      { label: "Agreement status", value: "Draft" },
    ],
  },
  {
    title: "Identity verification",
    body: "Before the agreement can be signed, both Person A and Person B complete identity verification — a required step for every signature and payment on PAY2PAY.",
    stats: [
      { label: "Person A", value: "Verified" },
      { label: "Person B", value: "Verified" },
      { label: "Agreement status", value: "Ready to sign" },
    ],
  },
  {
    title: "Signing",
    body: "Person A signs. Person B signs. The terms are now locked and cannot be changed unilaterally.",
    stats: [
      { label: "Signed by", value: "Both parties" },
      { label: "Principal", value: "$1,000" },
      { label: "Agreement status", value: "Signed" },
    ],
  },
  {
    title: "Payment method",
    body: "Person A connects a bank account to fund payments. Person B connects a bank account to receive them.",
    stats: [
      { label: "Funding account", value: "Connected" },
      { label: "Payout account", value: "Connected" },
      { label: "Relationship status", value: "Active" },
    ],
  },
  {
    title: "First payment — $250",
    body: "The first $250 payment clears. The remaining balance drops from $1,000 to $750.",
    stats: [
      { label: "Payment", value: "$250" },
      { label: "Remaining balance", value: "$750" },
      { label: "Payments made", value: "1 of 4" },
    ],
  },
  {
    title: "Subsequent payments",
    body: "Two more $250 payments clear on schedule, each one further reducing the balance.",
    stats: [
      { label: "Payments made", value: "3 of 4" },
      { label: "Remaining balance", value: "$250" },
      { label: "Total paid", value: "$750" },
    ],
  },
  {
    title: "Paid in full",
    body: "The final $250 payment clears. The $1,000 debt is fully repaid, and the agreement's record remains available to both parties.",
    stats: [
      { label: "Remaining balance", value: "$0" },
      { label: "Total paid", value: "$1,000" },
      { label: "Agreement status", value: "Paid in full" },
    ],
  },
];

export function P2PDemo() {
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex]!;

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <DemoBanner />
      <div>
        <span className="eyebrow"><span /> P2P Demo — Person A owes Person B $1,000</span>
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
