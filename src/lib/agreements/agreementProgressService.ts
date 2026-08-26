import "server-only";
import type { AgreementService, AgreementStatus, PartyRole } from "./agreementService";
import { isPastDate } from "./schedule";

export type AgreementProgressStepKey =
  | "details_terms"
  | "acceptance"
  | "payment_method"
  | "signatures"
  | "active";

export type AgreementProgressStepStatus =
  | "complete"
  | "current"
  | "action_required"
  | "waiting"
  | "blocked"
  | "optional"
  | "not_started"
  | "cancelled";

export interface AgreementProgressCta {
  label: string;
  href: string;
}

export interface AgreementProgressStep {
  key: AgreementProgressStepKey;
  label: string;
  status: AgreementProgressStepStatus;
  description: string;
  cta: AgreementProgressCta | null;
}

export interface AgreementPrimaryAction {
  label: string;
  description: string;
  cta: AgreementProgressCta | null;
}

export interface AgreementProgress {
  agreementId: string;
  myRole: PartyRole;
  status: AgreementStatus;
  steps: AgreementProgressStep[];
  primaryAction: AgreementPrimaryAction;
  /** Count of steps whose action is mine to take right now — drives "N items required" messaging. */
  actionableForMeCount: number;
}

/** Narrow view onto RelationshipFinancialAccountService.getRelationshipAccounts — see that method's own doc comment for authorization (participant-only). */
export interface RelationshipPaymentMethodReader {
  getRelationshipAccounts(
    relationshipId: string,
    actingUserId: string,
  ): Promise<Array<{ usage: "funding" | "payout"; status: string; financialAccount: { status: string } }>>;
}

/**
 * Cancellation progress display fix: what the agreement's status *was* immediately before
 * AgreementService.cancelAgreement overwrote it to "mutually_canceled" — the only way to tell
 * whether acceptance had genuinely completed before cancellation, since the current status alone no
 * longer distinguishes that.
 */
export interface AgreementCancellationInfo {
  previousStatus: AgreementStatus;
}

/** Narrow view onto the audit trail — see DrizzleAgreementCancellationReader's own doc comment for why this reads audit_event rather than a new column. */
export interface AgreementCancellationReader {
  getCancellationInfo(agreementId: string): Promise<AgreementCancellationInfo | null>;
}

export interface AgreementProgressServiceDeps {
  agreementService: AgreementService;
  relationshipPaymentMethods: RelationshipPaymentMethodReader;
  cancellation: AgreementCancellationReader;
}

const STATUS_LABELS: Record<AgreementStatus, string> = {
  draft: "Draft",
  awaiting_debtor_acknowledgment: "Awaiting debtor acknowledgment",
  awaiting_creditor_acceptance: "Awaiting creditor acceptance",
  awaiting_signatures: "Awaiting signatures",
  signed: "Signed",
  first_payment_pending: "First payment pending",
  active: "Active",
  past_due: "Past due",
  disputed: "Disputed",
  paused_by_amendment: "Paused",
  paid_in_full: "Paid in full",
  settled_in_full: "Settled in full",
  mutually_canceled: "Canceled",
  closed: "Closed",
};

/**
 * Agreement workflow remediation (Problem 3 — no guided workflow): the single, server-authoritative
 * place that derives "where is this agreement, what's done, what's missing, whose turn is it, what
 * do they click next." This is UX guidance only — every actual gate it reports on (step-up,
 * signature authorization, activation) is independently enforced by AgreementService/
 * SignatureService regardless of what this service says; a client can never use this to sign or
 * activate anything (see this file's own README-equivalent in the completion report).
 *
 * Read-only and defensive: any single dependency read failing (e.g. the acting party's relationship
 * isn't resolvable) degrades that one step to a safe, non-blocking default rather than failing the
 * whole page — the underlying AgreementService.getAgreement call is the only read whose failure is
 * allowed to propagate (no agreement, no page).
 *
 * Deliberately does NOT model MFA step-up as its own progress step: it is a same-second,
 * session-scoped challenge already handled perfectly inline at the moment of signing by
 * useStepUpGuardedAction/StepUpChallenge — surfacing it here as a persistent "step" would just be
 * stale the instant it's read, and would duplicate a flow that already satisfies every "launch the
 * challenge directly from the signing workflow, preserve context, return to the same agreement"
 * requirement without any changes needed.
 *
 * Production follow-up (Remove Step 4 — Identity Verification): identity verification is no
 * longer part of the agreement workflow at all — there is no step for it, and `signaturesStep`
 * below has no verification-related gate. This mirrors SignatureService.sign, which no longer
 * checks verification state before allowing a signature. Payment-provider KYC/identity
 * functionality itself (VerificationService, the identity-verification record repository, the
 * admin verification queue) is untouched — this service simply no longer surfaces or depends on it.
 */
export class AgreementProgressService {
  constructor(private readonly deps: AgreementProgressServiceDeps) {}

  async getProgress(agreementId: string, actingUserId: string): Promise<AgreementProgress> {
    const detail = await this.deps.agreementService.getAgreement(agreementId, actingUserId);
    const myRole = await this.deps.agreementService.resolvePartyRole(agreementId, actingUserId);
    const otherRole: PartyRole = myRole === "creditor" ? "debtor" : "creditor";
    const { agreement, version } = detail;

    // Cancellation progress display fix: cancellation is a terminal workflow state. Every step from
    // the point of cancellation onward must read "Cancelled" — never action_required/blocked/complete,
    // which would wrongly invite the user to keep verifying, signing, or activating a dead agreement.
    // Handled as its own branch (rather than patched into each step method below) so this is the one
    // place that ever needs to reason about "what happens after cancellation" — every consumer
    // (Agreement Detail, the agreements list's attentionLabel, mobile) reads this same result.
    if (agreement.status === "mutually_canceled") {
      return this.buildCancelledProgress(agreementId, myRole, agreement.relationshipId, actingUserId);
    }

    const steps: AgreementProgressStep[] = [];

    // Step 1 — details & terms: always complete once an agreement row exists (creation is atomic —
    // this codebase has no partial "details entered but no terms yet" state to represent).
    steps.push({
      key: "details_terms",
      label: "Agreement details & terms",
      status: "complete",
      description: `${version.terms.category} — ${version.terms.description}`,
      cta: null,
    });

    // Step 2 — acceptance: draft (either party submits) -> debtor acknowledges -> creditor decides.
    steps.push(this.acceptanceStep(agreement.status, myRole));

    // Step 3 — payment method: informational, not a hard gate (matches actual activation logic —
    // AgreementCompletionService activates purely on a cleared payment, never on account assignment).
    steps.push(await this.paymentMethodStep(agreement.relationshipId, myRole, actingUserId));

    // Step 4 — signatures: dependency-aware only on the schedule not being stale — never invites a
    // signature attempt that would just fail server-side. Also Originator/Counterparty aware
    // (Agreement Lifecycle V2): the counterparty must sign first, so an originator with nothing else
    // blocking them still shows "waiting", never a same-moment "action_required" for both parties.
    const originatorRole = await this.deps.agreementService.resolvePartyRole(agreementId, agreement.createdByUserId);
    steps.push(
      this.signaturesStep({
        status: agreement.status,
        myRole,
        otherRole,
        isOriginator: myRole === originatorRole,
        creditorSignedAt: version.creditorSignedAt,
        debtorSignedAt: version.debtorSignedAt,
        firstPaymentDate: version.terms.firstPaymentDate,
      }),
    );

    // Step 5 — active.
    steps.push(this.activeStep(agreement.status));

    const actionableForMeCount = steps.filter((s) => s.status === "action_required").length;
    const primaryAction = this.computePrimaryAction(steps, agreement.status, myRole);

    return { agreementId, myRole, status: agreement.status, steps, primaryAction, actionableForMeCount };
  }

  /**
   * Cancellation progress display fix: builds the terminal progress result for a cancelled
   * agreement. Steps 1 (details) and 3 (payment method) are unaffected by cancellation and keep
   * their normal, truthful status. Step 2 (acceptance) shows "Complete" only if the agreement had
   * genuinely reached awaiting_signatures before being cancelled (both debtor acknowledgment and
   * creditor acceptance actually happened) — otherwise "Cancelled", never a retroactive "Complete"
   * for a phase that never finished. Steps 4-5 (signatures, active) are always "Cancelled": once
   * cancelled, there is no further prerequisite to complete or gate.
   */
  private async buildCancelledProgress(
    agreementId: string,
    myRole: PartyRole,
    relationshipId: string | null,
    actingUserId: string,
  ): Promise<AgreementProgress> {
    const cancellationInfo = await this.deps.cancellation.getCancellationInfo(agreementId);
    const acceptanceHadCompleted = !!cancellationInfo && !["draft", "awaiting_debtor_acknowledgment", "awaiting_creditor_acceptance"].includes(cancellationInfo.previousStatus);

    const steps: AgreementProgressStep[] = [
      {
        key: "details_terms",
        label: "Agreement details & terms",
        status: "complete",
        description: "Agreement details and terms were recorded before cancellation.",
        cta: null,
      },
      acceptanceHadCompleted
        ? {
            key: "acceptance",
            label: "Review & acceptance",
            status: "complete",
            description: "Both parties had reviewed and accepted these terms before this agreement was cancelled.",
            cta: null,
          }
        : this.cancelledStep("acceptance", "Review & acceptance"),
      await this.paymentMethodStep(relationshipId, myRole, actingUserId),
      this.cancelledStep("signatures", "Review & signatures"),
      this.cancelledStep("active", "Agreement active"),
    ];

    return {
      agreementId,
      myRole,
      status: "mutually_canceled",
      steps,
      primaryAction: {
        label: "Agreement cancelled",
        description: "No further action is required for this agreement.",
        cta: null,
      },
      actionableForMeCount: 0,
    };
  }

  private cancelledStep(key: AgreementProgressStepKey, label: string): AgreementProgressStep {
    return {
      key,
      label,
      status: "cancelled",
      description: "This agreement was cancelled. No further action is required.",
      cta: null,
    };
  }

  private acceptanceStep(status: AgreementStatus, myRole: PartyRole): AgreementProgressStep {
    const preAcceptance: AgreementStatus[] = ["draft", "awaiting_debtor_acknowledgment", "awaiting_creditor_acceptance"];
    if (!preAcceptance.includes(status)) {
      return {
        key: "acceptance",
        label: "Review & acceptance",
        status: "complete",
        description: "Both parties have reviewed and accepted these terms.",
        cta: null,
      };
    }
    if (status === "draft") {
      return {
        key: "acceptance",
        label: "Review & acceptance",
        status: "action_required",
        description: "This agreement is still a draft. Submit it to notify the debtor.",
        cta: null,
      };
    }
    if (status === "awaiting_debtor_acknowledgment") {
      return myRole === "debtor"
        ? {
            key: "acceptance",
            label: "Review & acceptance",
            status: "action_required",
            description: "Acknowledge that this debt is owed before it can move forward.",
            cta: null,
          }
        : {
            key: "acceptance",
            label: "Review & acceptance",
            status: "waiting",
            description: "Waiting for the debtor to acknowledge this obligation.",
            cta: null,
          };
    }
    // awaiting_creditor_acceptance
    return myRole === "creditor"
      ? {
          key: "acceptance",
          label: "Review & acceptance",
          status: "action_required",
          description: "Accept, reject, or counter these terms.",
          cta: null,
        }
      : {
          key: "acceptance",
          label: "Review & acceptance",
          status: "waiting",
          description: "Waiting for the creditor to accept these terms.",
          cta: null,
        };
  }

  private async paymentMethodStep(
    relationshipId: string | null,
    myRole: PartyRole,
    actingUserId: string,
  ): Promise<AgreementProgressStep> {
    if (!relationshipId) {
      return {
        key: "payment_method",
        label: "Payment method",
        status: "optional",
        description: "Not required for this agreement.",
        cta: null,
      };
    }
    const requiredUsage = myRole === "debtor" ? "funding" : "payout";
    try {
      const accounts = await this.deps.relationshipPaymentMethods.getRelationshipAccounts(relationshipId, actingUserId);
      const hasActive = accounts.some(
        (a) => a.usage === requiredUsage && a.status === "active" && a.financialAccount.status !== "disabled",
      );
      return hasActive
        ? {
            key: "payment_method",
            label: "Payment method",
            status: "complete",
            description: myRole === "debtor" ? "A funding account is connected." : "A payout account is connected.",
            cta: null,
          }
        : {
            key: "payment_method",
            label: "Payment method",
            status: "action_required",
            description:
              myRole === "debtor"
                ? "Add a funding account before making payments on this agreement."
                : "Add a payout account before you can receive payments on this agreement.",
            cta: { label: "Add payment method", href: "/payment-methods" },
          };
    } catch {
      // Not a participant of the linked relationship, or it's not resolvable — degrade to
      // informational rather than failing the whole progress read (see class doc comment).
      return {
        key: "payment_method",
        label: "Payment method",
        status: "optional",
        description: "Not required for this agreement.",
        cta: null,
      };
    }
  }

  private signaturesStep(input: {
    status: AgreementStatus;
    myRole: PartyRole;
    otherRole: PartyRole;
    isOriginator: boolean;
    creditorSignedAt: Date | string | null;
    debtorSignedAt: Date | string | null;
    firstPaymentDate: string;
  }): AgreementProgressStep {
    const preSignatures: AgreementStatus[] = ["draft", "awaiting_debtor_acknowledgment", "awaiting_creditor_acceptance"];
    if (preSignatures.includes(input.status)) {
      return {
        key: "signatures",
        label: "Review & signatures",
        status: "not_started",
        description: "Both parties must accept these terms before signing.",
        cta: null,
      };
    }
    if (input.status !== "awaiting_signatures") {
      return {
        key: "signatures",
        label: "Review & signatures",
        status: "complete",
        description: "Both parties have signed.",
        cta: null,
      };
    }

    const iSigned = input.myRole === "creditor" ? !!input.creditorSignedAt : !!input.debtorSignedAt;

    if (iSigned) {
      return {
        key: "signatures",
        label: "Review & signatures",
        status: "waiting",
        description: `You've signed. Waiting for the ${input.otherRole} to sign.`,
        cta: null,
      };
    }
    if (isPastDate(input.firstPaymentDate)) {
      return {
        key: "signatures",
        label: "Review & signatures",
        status: "blocked",
        description: `The proposed first payment date (${input.firstPaymentDate}) has already passed. This agreement's schedule must be revised before either party can sign.`,
        cta: null,
      };
    }
    if (input.isOriginator) {
      // Counterparty-first-signing rule (Agreement Lifecycle V2): the originator can't sign until the
      // counterparty has, regardless of whatever else is ready — mirrors CounterpartyMustSignFirstError.
      // Once the counterparty HAS signed, it genuinely is the originator's turn (falls through below).
      const counterpartySigned = input.otherRole === "creditor" ? !!input.creditorSignedAt : !!input.debtorSignedAt;
      if (!counterpartySigned) {
        return {
          key: "signatures",
          label: "Review & signatures",
          status: "waiting",
          description: "The other party must review and sign first. You'll be notified as soon as they do.",
          cta: null,
        };
      }
    }
    return {
      key: "signatures",
      label: "Review & signatures",
      status: "action_required",
      description: "Review the agreement and sign to continue.",
      cta: null,
    };
  }

  private activeStep(status: AgreementStatus): AgreementProgressStep {
    if (status === "first_payment_pending") {
      return {
        key: "active",
        label: "Agreement active",
        status: "waiting",
        description: "Signed. Waiting for the first payment to clear.",
        cta: null,
      };
    }
    const completedStates: AgreementStatus[] = ["active", "past_due", "paid_in_full", "settled_in_full"];
    if (completedStates.includes(status)) {
      return {
        key: "active",
        label: "Agreement active",
        status: "complete",
        description: status === "paid_in_full" || status === "settled_in_full" ? "This agreement is complete." : "This agreement is active.",
        cta: null,
      };
    }
    // "mutually_canceled" is deliberately not handled here — getProgress returns via
    // buildCancelledProgress before this method is ever reached for that status.
    if (status === "disputed" || status === "paused_by_amendment" || status === "closed") {
      return {
        key: "active",
        label: "Agreement active",
        status: "blocked",
        description: STATUS_LABELS[status],
        cta: null,
      };
    }
    return {
      key: "active",
      label: "Agreement active",
      status: "not_started",
      description: "Not yet reached.",
      cta: null,
    };
  }

  private computePrimaryAction(steps: AgreementProgressStep[], status: AgreementStatus, myRole: PartyRole): AgreementPrimaryAction {
    const mine = steps.find((s) => s.status === "action_required");
    if (mine) {
      return { label: mine.cta?.label ?? mine.label, description: mine.description, cta: mine.cta };
    }
    const blocked = steps.find((s) => s.status === "blocked");
    if (blocked) {
      return { label: blocked.label, description: blocked.description, cta: blocked.cta };
    }
    const waiting = steps.find((s) => s.status === "waiting");
    if (waiting) {
      return { label: "Waiting for other party", description: waiting.description, cta: null };
    }
    if (status === "active" || status === "past_due") {
      return myRole === "debtor"
        ? { label: "Make payment", description: "Continue making scheduled payments.", cta: { label: "Make payment", href: "/payments" } }
        : { label: "Agreement active", description: "This agreement is active.", cta: null };
    }
    if (status === "paid_in_full" || status === "settled_in_full") {
      return { label: "Agreement complete", description: "This agreement is complete.", cta: null };
    }
    return { label: "No action needed", description: "Nothing requires your attention right now.", cta: null };
  }
}
