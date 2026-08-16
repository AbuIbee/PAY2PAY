import type { NotificationEventType } from "./eventTypes";

export interface RenderedNotification {
  subject: string;
  emailBody: string;
  smsBody: string;
  inAppBody: string;
}

export type NotificationTemplate = (payload: Record<string, unknown>) => RenderedNotification;

function str(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** Mirrors src/lib/documents/agreementPdf.ts's identical formatDollars helper — kept as its own tiny copy here rather than a shared cross-module export, matching this codebase's tolerance for small, pure, single-line formatting helpers over premature abstraction. */
function displayAmount(payload: Record<string, unknown>, fallback: string): string {
  const amountMinorUnits = payload.amountMinorUnits;
  const currency = payload.currency;
  if (typeof amountMinorUnits === "number" && typeof currency === "string") {
    return `${(amountMinorUnits / 100).toFixed(2)} ${currency}`;
  }
  return str(payload, "displayAmount", fallback);
}

/**
 * Sprint 17 (docs/sprints/SPRINT_17_Notifications.md): code-based templates, not a DB-stored/CMS
 * template system — no admin UI or template-editing workflow was requested by this sprint's
 * instruction text, matching this project's established precedent for other rendering concerns with
 * no live external system to source them from (e.g. Sprint 6's PDF generation, Sprint 5's schedule
 * computation — both code, not configuration). `smsBody` is deliberately short (SMS has a practical
 * length ceiling); `emailBody`/`inAppBody` may be fuller. Only non-sensitive fields ever appear here —
 * `payment_failed`'s own body follows Sprint 13's identical "non-sensitive only" precedent
 * (`docs/PAYMENT_ARCHITECTURE.md` §6), extended to every other template.
 */
export const NOTIFICATION_TEMPLATES: Record<NotificationEventType, NotificationTemplate> = {
  agreement_invitation: (p) => {
    const from = str(p, "counterpartyName", "Someone");
    return {
      subject: "You've been invited to a repayment agreement",
      emailBody: `${from} has invited you to review and sign a repayment agreement on PAY2PAY.`,
      smsBody: `${from} invited you to a repayment agreement on PAY2PAY. Check your email or the app for details.`,
      inAppBody: `${from} invited you to a repayment agreement.`,
    };
  },
  agreement_signed: () => ({
    subject: "Your agreement has been fully signed",
    emailBody: "Both parties have now signed this agreement. It is active and the first payment is now scheduled.",
    smsBody: "Your PAY2PAY agreement is now fully signed and active.",
    inAppBody: "This agreement has been fully signed by both parties.",
  }),
  amendment: (p) => {
    const changeType = str(p, "changeType", "a change");
    return {
      subject: "A change has been proposed to your agreement",
      emailBody: `A proposed amendment (${changeType}) is awaiting your review.`,
      smsBody: `An amendment to your PAY2PAY agreement needs your review.`,
      inAppBody: `An amendment (${changeType}) is awaiting your review.`,
    };
  },
  payment_scheduled: (p) => {
    const date = str(p, "scheduledFor", "the scheduled date");
    return {
      subject: "A payment has been scheduled",
      emailBody: `A payment is scheduled for ${date}.`,
      smsBody: `A PAY2PAY payment is scheduled for ${date}.`,
      inAppBody: `A payment is scheduled for ${date}.`,
    };
  },
  payment_processing: () => ({
    subject: "Your payment is processing",
    emailBody: "A payment is now processing with your bank or card issuer.",
    smsBody: "Your PAY2PAY payment is processing.",
    inAppBody: "A payment is processing.",
  }),
  payment_cleared: (p) => {
    const amount = displayAmount(p, "A payment");
    return {
      subject: "A payment has cleared",
      emailBody: `${amount} has cleared successfully.`,
      smsBody: `${amount} cleared on PAY2PAY.`,
      inAppBody: `${amount} cleared successfully.`,
    };
  },
  payment_failed: (p) => {
    const category = str(p, "failureCategory", "an issue with the payment method");
    return {
      subject: "A payment did not go through",
      emailBody: `A scheduled payment could not be completed (${category}). A manual payment can be made now, or the system will automatically retry once.`,
      smsBody: `A PAY2PAY payment failed (${category}). A retry is scheduled, or you can pay manually now.`,
      inAppBody: `A payment failed (${category}).`,
    };
  },
  payment_disputed: () => ({
    subject: "A payment has been disputed",
    emailBody: "A payment on your agreement has been disputed as unauthorized. The processor will review and determine the outcome.",
    smsBody: "A PAY2PAY payment has been disputed. Check your email for details.",
    inAppBody: "A payment has been disputed as unauthorized.",
  }),
  bank_change: () => ({
    subject: "Your bank account authorization has changed",
    emailBody: "Your ACH bank account authorization has changed. If you did not make this change, contact support immediately.",
    smsBody: "Your PAY2PAY bank authorization changed. If this wasn't you, contact support now.",
    inAppBody: "Your bank account authorization has changed.",
  }),
  card_change: () => ({
    subject: "Your card on file has changed",
    emailBody: "Your debit card on file has changed. If you did not make this change, contact support immediately.",
    smsBody: "Your PAY2PAY card on file changed. If this wasn't you, contact support now.",
    inAppBody: "Your card on file has changed.",
  }),
  authorization_revoked: () => ({
    subject: "A payment authorization has been revoked",
    emailBody: "A payment authorization (mandate or card) on your agreement has been revoked. Future automatic payments will not be collected until a new authorization is provided.",
    smsBody: "A PAY2PAY payment authorization was revoked. Future auto-payments are paused.",
    inAppBody: "A payment authorization has been revoked.",
  }),
  hardship: () => ({
    subject: "A hardship request needs attention",
    emailBody: "A hardship relief request has been submitted or updated on your agreement.",
    smsBody: "A hardship request on your PAY2PAY agreement needs attention.",
    inAppBody: "A hardship request needs attention.",
  }),
  partial_payment: () => ({
    subject: "A partial payment request needs attention",
    emailBody: "A partial payment request has been submitted or updated on your agreement.",
    smsBody: "A partial payment request on your PAY2PAY agreement needs attention.",
    inAppBody: "A partial payment request needs attention.",
  }),
  settlement: () => ({
    subject: "A settlement proposal needs attention",
    emailBody: "A settlement proposal has been submitted or updated on your agreement.",
    smsBody: "A settlement proposal on your PAY2PAY agreement needs attention.",
    inAppBody: "A settlement proposal needs attention.",
  }),
  security_event: (p) => {
    const description = str(p, "description", "A security-relevant event occurred on your account");
    return {
      subject: "Security alert on your account",
      emailBody: `${description}. If this wasn't you, contact support immediately.`,
      smsBody: `PAY2PAY security alert: ${description}. If this wasn't you, contact support.`,
      inAppBody: `Security alert: ${description}.`,
    };
  },
  staff_permissions: () => ({
    subject: "Staff permissions have changed",
    emailBody: "A staff member's role or permissions have changed on your business account.",
    smsBody: "Staff permissions changed on your PAY2PAY business account.",
    inAppBody: "Staff permissions have changed.",
  }),
  payout_account_change: () => ({
    subject: "Your payout account has changed",
    emailBody: "The account receiving your payouts has changed. If you did not make this change, contact support immediately.",
    smsBody: "Your PAY2PAY payout account changed. If this wasn't you, contact support now.",
    inAppBody: "Your payout account has changed.",
  }),
  account_restriction: (p) => {
    const reason = str(p, "reason", "a policy or dispute review");
    return {
      subject: "A restriction has been placed on your account",
      emailBody: `A restriction has been placed on your account or agreement (${reason}).`,
      smsBody: `A restriction was placed on your PAY2PAY account (${reason}).`,
      inAppBody: `A restriction has been placed on your account (${reason}).`,
    };
  },
  relationship_invitation: () => ({
    subject: "You have a pending relationship invitation",
    emailBody: "You've been invited to a cooperative payment relationship on PAY2PAY. Log in to review and respond.",
    smsBody: "You have a pending PAY2PAY relationship invitation. Log in to review.",
    inAppBody: "You have a pending relationship invitation.",
  }),
  relationship_accepted: () => ({
    subject: "Your relationship invitation was accepted",
    emailBody: "The invitation you sent has been accepted. The relationship can now proceed to setup.",
    smsBody: "Your PAY2PAY relationship invitation was accepted.",
    inAppBody: "Your relationship invitation was accepted.",
  }),
  relationship_declined: () => ({
    subject: "Your relationship invitation was declined",
    emailBody: "The invitation you sent has been declined.",
    smsBody: "Your PAY2PAY relationship invitation was declined.",
    inAppBody: "Your relationship invitation was declined.",
  }),
  relationship_activated: () => ({
    subject: "Your relationship is now active",
    emailBody: "Your cooperative payment relationship is fully set up and now active.",
    smsBody: "Your PAY2PAY relationship is now active.",
    inAppBody: "This relationship is now active.",
  }),
  relationship_restricted: (p) => {
    const reason = str(p, "reason", "a policy or compliance review");
    return {
      subject: "A restriction has been placed on your relationship",
      emailBody: `A restriction has been placed on this relationship (${reason}).`,
      smsBody: `A restriction was placed on your PAY2PAY relationship (${reason}).`,
      inAppBody: `A restriction has been placed on this relationship (${reason}).`,
    };
  },
  relationship_funding_account_replaced: () => ({
    subject: "The funding account for your relationship has changed",
    emailBody: "The account funds are pulled from for this relationship has changed. If you did not expect this, contact support immediately.",
    smsBody: "Your PAY2PAY relationship funding account changed. If this wasn't expected, contact support.",
    inAppBody: "The funding account for this relationship has changed.",
  }),
  relationship_payout_account_replaced: () => ({
    subject: "The payout account for your relationship has changed",
    emailBody: "The account receiving payouts for this relationship has changed. If you did not expect this, contact support immediately.",
    smsBody: "Your PAY2PAY relationship payout account changed. If this wasn't expected, contact support.",
    inAppBody: "The payout account for this relationship has changed.",
  }),
  appeal_decided: (p) => {
    const decision = str(p, "decision", "decided");
    return {
      subject: "A decision has been made on your appeal",
      emailBody: `Your appeal has been reviewed and the decision is: ${decision}.`,
      smsBody: `Your PAY2PAY appeal decision: ${decision}.`,
      inAppBody: `Your appeal decision: ${decision}.`,
    };
  },
  agreement_invitation_response: (p) => {
    const action = str(p, "action", "responded");
    const label = action === "accepted" ? "accepted your proposal" : action === "declined" ? "declined your proposal" : "requested changes to your proposal";
    return {
      subject: "There's an update on your payment plan proposal",
      emailBody: `The recipient of your payment plan proposal has ${label}.`,
      smsBody: `PAY2PAY: your proposal was ${action === "accepted" ? "accepted" : action === "declined" ? "declined" : "countered"}.`,
      inAppBody: `Your proposal recipient has ${label}.`,
    };
  },
};
