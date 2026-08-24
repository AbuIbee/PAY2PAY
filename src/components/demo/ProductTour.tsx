"use client";

import { useState } from "react";
import { DemoBanner } from "./DemoBanner";
import { DemoStepControls } from "./DemoStepControls";

interface TourStep {
  area: string;
  whatFor: string;
  whatYouCanDo: string;
  whatsNext: string;
}

/**
 * Demo navigation & dedicated demo experiences (Product Owner request): a guided, no-signup tour of
 * PAY2PAY's 11 primary areas — each step explains what the page is for, what the user can do there,
 * and what normally comes next. No fixture data is fetched from the real app (no network calls at
 * all); this is a self-contained explainer, not a live walkthrough of a seeded account.
 */
const TOUR_STEPS: TourStep[] = [
  {
    area: "Dashboard",
    whatFor: "Your home base — a snapshot of what you owe, what's owed to you, your active agreements, and anything that needs your attention right now.",
    whatYouCanDo: "See your balances at a glance, jump to any pending invitation or agreement awaiting your signature, and check unread notifications.",
    whatsNext: "From here, most people head to Connections to start a new relationship, or to Agreements to check on an existing one.",
  },
  {
    area: "Connections",
    whatFor: "Where every relationship with another person or business lives — the people and businesses you owe money to, or who owe money to you.",
    whatYouCanDo: "Invite someone new to connect, review a connection's details, and see pending invitations you've sent or received.",
    whatsNext: "Once a connection is accepted and set up, the next step is usually creating an Agreement together.",
  },
  {
    area: "Agreements",
    whatFor: "The documented terms of a repayment — principal, schedule, and any special conditions like early payoff or hardship rules.",
    whatYouCanDo: "Draft a new agreement with a connection, review the terms, sign, and track its status through the repayment lifecycle.",
    whatsNext: "Once both parties sign, the agreement becomes active and its scheduled Payments begin.",
  },
  {
    area: "Payments",
    whatFor: "A running record of every payment tied to your agreements — made, received, scheduled, or failed.",
    whatYouCanDo: "Review payment history, check on a specific payment's status, and see what's scheduled next.",
    whatsNext: "If a payment method needs attention, that's managed under Payment Methods.",
  },
  {
    area: "Payment Methods",
    whatFor: "The bank accounts (and cards, where available) used to fund and receive payments.",
    whatYouCanDo: "Connect a new bank account, see which accounts are verified, and remove an account you no longer use.",
    whatsNext: "A verified payment method is required before it can be assigned as an agreement's funding or payout source.",
  },
  {
    area: "Notifications",
    whatFor: "Real-time updates on invitations, signatures, and payments as they happen — so nothing gets missed.",
    whatYouCanDo: "Review recent activity and jump straight to the connection, agreement, or payment a notification refers to.",
    whatsNext: "Most notifications lead directly to an action waiting for you elsewhere in the app — usually Connections or Agreements.",
  },
  {
    area: "Support",
    whatFor: "Where to go if something needs a human — a dispute, a question about an agreement, or an account issue.",
    whatYouCanDo: "Open a support case, track its status, and file an appeal if you disagree with a prior decision.",
    whatsNext: "A support case is reviewed by the team; you'll be notified here and in Notifications once there's an update.",
  },
  {
    area: "Settings",
    whatFor: "Your basic account information — email, verification status, and account-level preferences.",
    whatYouCanDo: "Review your account details, resend a verification email, and export your data.",
    whatsNext: "For anything security-related — like two-factor authentication — that lives under Security.",
  },
  {
    area: "Security",
    whatFor: "Keeping your account safe — two-factor authentication and session management.",
    whatYouCanDo: "Set up an authenticator app or text-message verification, and see what's required before a sensitive action (like signing or connecting a bank account) can go through.",
    whatsNext: "Once two-factor authentication is set up, you'll be asked for a fresh code before sensitive actions — a normal, expected step, not an error.",
  },
  {
    area: "Verification",
    whatFor: "PAY2PAY's identity verification tier — required before you can sign an agreement or send/receive a payment.",
    whatYouCanDo: "Request full verification and check its current status.",
    whatsNext: "Full verification is reviewed by the team, not automatic — once approved, agreements can be signed and payments can flow.",
  },
  {
    area: "Staff & Organization",
    whatFor: "For a business profile — who's authorized to act on the business's behalf, and with what permissions.",
    whatYouCanDo: "Invite staff, assign roles, and review or approve actions that require another staff member's sign-off.",
    whatsNext: "This area only applies when you're acting as a business — switch profiles from the account menu to see it in context.",
  },
];

export function ProductTour() {
  const [stepIndex, setStepIndex] = useState(0);
  const step = TOUR_STEPS[stepIndex]!;

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <DemoBanner />
      <div>
        <span className="eyebrow"><span /> Product Tour — {step.area}</span>
        <h2 style={{ margin: "0.8rem 0 1rem", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "1.7rem", fontWeight: 500 }}>
          {step.area}
        </h2>
        <div style={{ display: "grid", gap: "0.9rem" }}>
          <p style={{ margin: 0, color: "var(--ink-soft)", lineHeight: 1.7 }}>
            <strong style={{ color: "var(--ink)" }}>What it&apos;s for: </strong>
            {step.whatFor}
          </p>
          <p style={{ margin: 0, color: "var(--ink-soft)", lineHeight: 1.7 }}>
            <strong style={{ color: "var(--ink)" }}>What you can do here: </strong>
            {step.whatYouCanDo}
          </p>
          <p style={{ margin: 0, color: "var(--ink-soft)", lineHeight: 1.7 }}>
            <strong style={{ color: "var(--ink)" }}>What normally comes next: </strong>
            {step.whatsNext}
          </p>
        </div>
      </div>
      <DemoStepControls
        stepIndex={stepIndex}
        totalSteps={TOUR_STEPS.length}
        onBack={() => setStepIndex((i) => Math.max(0, i - 1))}
        onNext={() => setStepIndex((i) => Math.min(TOUR_STEPS.length - 1, i + 1))}
        exitLabel="Exit Tour"
        lastStepHref="/demo"
        lastStepLabel="Finish tour"
      />
    </div>
  );
}
