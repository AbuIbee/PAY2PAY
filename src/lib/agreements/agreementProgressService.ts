import "server-only";
import type { AgreementService, AgreementStatus, PartyRole, ProfileRef } from "./agreementService";
import { isPastDate } from "./schedule";
import type { ProfileKind, VerificationState } from "@/lib/profiles/verificationService";

export type AgreementProgressStepKey =
  | "details_terms"
  | "acceptance"
  | "payment_method"
  | "identity_verification"
  | "signatures"
  | "active";

export type AgreementProgressStepStatus =
  | "complete"
  | "current"
  | "action_required"
  | "waiting"
  | "blocked"
  | "optional"
  | "not_started";

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

/**
 * Narrow view onto PersonalProfileRepository — this module only ever needs the acting user's own
 * personal-profile id (SignatureService's own identical dependency, for the identical reason: every
 * signer's own personal identity must be FULL_VERIFIED regardless of which party kind they're
 * signing for — see signatureService.ts's `sign` method).
 */
export interface PersonalProfileReader {
  findByUserId(userId: string): Promise<{ id: string } | null>;
}

/** Narrow view onto VerificationService — mirrors this codebase's interface-segregation precedent (e.g. AgreementBalanceComputer). */
export interface VerificationStateReader {
  getVerificationState(profileKind: ProfileKind, profileId: string): Promise<VerificationState>;
}

/** Narrow view onto RelationshipFinancialAccountService.getRelationshipAccounts — see that method's own doc comment for authorization (participant-only). */
export interface RelationshipPaymentMethodReader {
  getRelationshipAccounts(
    relationshipId: string,
    actingUserId: string,
  ): Promise<Array<{ usage: "funding" | "payout"; status: string; financialAccount: { status: string } }>>;
}

export interface AgreementProgressServiceDeps {
  agreementService: AgreementService;
  verification: VerificationStateReader;
  personalProfiles: PersonalProfileReader;
  relationshipPaymentMethods: RelationshipPaymentMethodReader;
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

function verificationStepStatus(state: VerificationState): "complete" | "action_required" | "blocked" {
  if (state === "FULL_VERIFIED") return "complete";
  if (state === "FULL_PENDING") return "blocked";
  return "action_required"; // UNVERIFIED, BASIC, FULL_REJECTED — all correctable by the user right now
}

function verificationDescription(state: VerificationState, isBusiness: boolean): string {
  const subject = isBusiness ? "This business" : "Your identity";
  switch (state) {
    case "FULL_VERIFIED":
      return `${subject} verification is complete.`;
    case "FULL_PENDING":
      return `${subject} verification request is being reviewed by our team. This isn't automatic — you'll be notified once a decision is made.`;
    case "FULL_REJECTED":
      return `${subject} verification was rejected. You can submit a new request.`;
    default:
      return `${subject} must complete full verification before signing this agreement.`;
  }
}

/**
 * Agreement workflow remediation (Problem 3 — no guided workflow; also the authoritative source for
 * Problem 1's actionable verification messaging): the single, server-authoritative place that derives
 * "where is this agreement, what's done, what's missing, whose turn is it, what do they click next."
 * This is UX guidance only — every actual gate it reports on (verification, step-up, signature
 * authorization, activation) is independently enforced by AgreementService/SignatureService/
 * VerificationService regardless of what this service says; a client can never use this to sign,
 * verify, or activate anything (see this file's own README-equivalent in the completion report).
 *
 * Read-only and defensive: any single dependency read failing (e.g. the acting party's relationship
 * isn't resolvable) degrades that one step to a safe, non-blocking default rather than failing the
 * whole page — the underlying AgreementService.getAgreement call is the only read whose failure is
 * allowed to propagate (no agreement, no page).
 *
 * Deliberately does NOT model MFA step-up as its own progress step: unlike identity verification
 * (which can sit PENDING for days awaiting review), step-up is a same-second, session-scoped
 * challenge already handled perfectly inline at the moment of signing by
 * useStepUpGuardedAction/StepUpChallenge — surfacing it here as a persistent "step" would just be
 * stale the instant it's read, and would duplicate a flow that already satisfies every "launch the
 * challenge directly from the signing workflow, preserve context, return to the same agreement"
 * requirement without any changes needed.
 */
export class AgreementProgressService {
  constructor(private readonly deps: AgreementProgressServiceDeps) {}

  async getProgress(agreementId: string, actingUserId: string): Promise<AgreementProgress> {
    const detail = await this.deps.agreementService.getAgreement(agreementId, actingUserId);
    const myRole = await this.deps.agreementService.resolvePartyRole(agreementId, actingUserId);
    const otherRole: PartyRole = myRole === "creditor" ? "debtor" : "creditor";
    const { agreement, version } = detail;
    const myParty: ProfileRef =
      myRole === "creditor"
        ? { kind: agreement.creditorProfileKind, id: agreement.creditorProfileId }
        : { kind: agreement.debtorProfileKind, id: agreement.debtorProfileId };

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

    // Step 4 — identity verification: mirrors SignatureService.sign's exact gates, in order, so this
    // step can never disagree with what actually blocks signing.
    const verificationStep = await this.identityVerificationStep(actingUserId, myParty);
    steps.push(verificationStep);

    // Step 5 — signatures: dependency-aware on verification and on the schedule not being stale —
    // never invites a signature attempt that would just fail server-side. Also Originator/Counterparty
    // aware (Agreement Lifecycle V2): the counterparty must sign first, so an originator with nothing
    // else blocking them still shows "waiting", never a same-moment "action_required" for both parties.
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
        verificationComplete: verificationStep.status === "complete",
      }),
    );

    // Step 6 — active.
    steps.push(this.activeStep(agreement.status));

    const actionableForMeCount = steps.filter((s) => s.status === "action_required").length;
    const primaryAction = this.computePrimaryAction(steps, agreement.status, myRole);

    return { agreementId, myRole, status: agreement.status, steps, primaryAction, actionableForMeCount };
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

  private async identityVerificationStep(actingUserId: string, myParty: ProfileRef): Promise<AgreementProgressStep> {
    const personalProfile = await this.deps.personalProfiles.findByUserId(actingUserId);
    if (!personalProfile) {
      return {
        key: "identity_verification",
        label: "Identity verification",
        status: "blocked",
        description: "No personal profile was found for this account.",
        cta: null,
      };
    }
    const personalState = await this.deps.verification.getVerificationState("personal", personalProfile.id);
    const personalStatus = verificationStepStatus(personalState);

    if (myParty.kind === "business") {
      const businessState = await this.deps.verification.getVerificationState("business", myParty.id);
      const businessStatus = verificationStepStatus(businessState);
      // Worst-of-both — signing requires BOTH gates to pass (signatureService.sign checks them
      // independently, either one failing blocks signing).
      if (personalStatus !== "complete" || businessStatus !== "complete") {
        const failing = personalStatus !== "complete" ? { state: personalState, isBusiness: false } : { state: businessState, isBusiness: true };
        const status = personalStatus === "action_required" || businessStatus === "action_required" ? "action_required" : "blocked";
        return {
          key: "identity_verification",
          label: "Identity verification",
          status,
          description: verificationDescription(failing.state, failing.isBusiness),
          cta: status === "action_required" ? { label: "Verify identity", href: "/account/verification" } : { label: "Check verification status", href: "/account/verification" },
        };
      }
      return {
        key: "identity_verification",
        label: "Identity verification",
        status: "complete",
        description: "Your identity and this business are both fully verified.",
        cta: null,
      };
    }

    if (personalStatus === "complete") {
      return {
        key: "identity_verification",
        label: "Identity verification",
        status: "complete",
        description: "Your identity is fully verified.",
        cta: null,
      };
    }
    return {
      key: "identity_verification",
      label: "Identity verification",
      status: personalStatus,
      description: verificationDescription(personalState, false),
      cta:
        personalStatus === "action_required"
          ? { label: "Verify identity", href: "/account/verification" }
          : { label: "Check verification status", href: "/account/verification" },
    };
  }

  private signaturesStep(input: {
    status: AgreementStatus;
    myRole: PartyRole;
    otherRole: PartyRole;
    isOriginator: boolean;
    creditorSignedAt: Date | string | null;
    debtorSignedAt: Date | string | null;
    firstPaymentDate: string;
    verificationComplete: boolean;
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
    if (!input.verificationComplete) {
      return {
        key: "signatures",
        label: "Review & signatures",
        status: "blocked",
        description: "Signing requires identity verification. Complete that step to continue.",
        cta: { label: "Verify identity", href: "/account/verification" },
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
    if (status === "disputed" || status === "paused_by_amendment" || status === "mutually_canceled" || status === "closed") {
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
