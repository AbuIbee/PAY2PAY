import "server-only";
import type { AgreementService, AgreementStatus, PartyRole } from "./agreementService";
import { isPastDate } from "./schedule";
import { formatMoney } from "@/lib/ui/money";

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
  /**
   * Restore agreement payment functionality: an optional override for the status chip's displayed
   * text. Added so Step 3/Step 5 can surface truthful, specific wording ("Payment setup required",
   * "Waiting for creditor payout setup", "Payment due", "Payment failed — action required") without
   * introducing new AgreementProgressStepStatus values — every pre-existing step (acceptance,
   * signatures) is unaffected and keeps falling back to the status's own generic label.
   */
  statusText?: string;
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

/**
 * Restore agreement payment functionality: narrow view onto AchMandateService.isActiveForAgreement.
 * The relationship-level funding assignment (RelationshipPaymentMethodReader above) says the debtor
 * has *chosen* a funding account; this says the debtor has actually authorized this specific
 * agreement to debit it — AchPaymentService.createManualPayment requires both, and until now nothing
 * in the progress workflow ever checked the second one.
 */
export interface AgreementMandateReader {
  isActiveForAgreement(agreementId: string): Promise<boolean>;
}

/** Narrow view onto BalanceService.getAgreementBalance — only the fields Step 5 needs to describe payment readiness truthfully. */
export interface AgreementBalanceReader {
  getAgreementBalance(agreementId: string): Promise<{
    remainingBalanceMinorUnits: number;
    currency: string;
    settlementState: "unpaid" | "partially_paid" | "paid_in_full" | "overpaid";
  }>;
}

/** One scheduled installment together with its live paid/past_due/waived state — see DrizzleAgreementInstallmentStatusReader's own doc comment for why this is a separate reader from AgreementService's own schedule projection. */
export interface InstallmentWithStatus {
  id: string;
  sequenceNumber: number;
  dueDate: string;
  amountMinorUnits: number;
  status: "scheduled" | "paid" | "past_due" | "waived";
}

export interface AgreementInstallmentStatusReader {
  listForAgreement(agreementId: string): Promise<InstallmentWithStatus[]>;
}

/** Narrow view onto PaymentAttemptRepository.listByAgreementId — only the fields Step 5 needs to tell "processing" from "failed" from "nothing attempted yet" for the next-due installment. */
export interface AgreementPaymentAttemptRecord {
  installmentScheduleItemId: string | null;
  status: string;
  failureReason: string | null;
  createdAt: Date;
}

export interface AgreementPaymentAttemptsReader {
  listByAgreementId(agreementId: string): Promise<AgreementPaymentAttemptRecord[]>;
}

export interface AgreementProgressServiceDeps {
  agreementService: AgreementService;
  relationshipPaymentMethods: RelationshipPaymentMethodReader;
  cancellation: AgreementCancellationReader;
  mandates: AgreementMandateReader;
  installments: AgreementInstallmentStatusReader;
  paymentAttempts: AgreementPaymentAttemptsReader;
  balance: AgreementBalanceReader;
}

/**
 * Restore agreement payment functionality: shared, computed-once payment-readiness snapshot for one
 * agreement/relationship, reused by both Step 3 (payment method) and Step 5 (active) so a single
 * getProgress() call never fetches the relationship's financial accounts or the agreement's mandate
 * twice.
 */
interface PaymentReadiness {
  debtorFundingAssigned: boolean;
  debtorMandateActive: boolean;
  creditorPayoutReady: boolean;
}

const OPEN_PAYMENT_ATTEMPT_STATUSES = new Set(["pending", "scheduled", "submitted", "processing"]);
const FAILED_PAYMENT_ATTEMPT_STATUSES = new Set(["failed", "canceled", "returned"]);

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
      return this.buildCancelledProgress(agreementId, myRole);
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

    // Step 3 — payment method: derives a truthful, role-specific readiness status (never a bare
    // "Optional") from the relationship's funding/payout assignment plus this agreement's own ACH
    // mandate — see PaymentReadiness's doc comment for why this is computed once and shared with
    // Step 5 below.
    const readiness = await this.computePaymentReadiness(agreement.relationshipId, agreementId, actingUserId);
    steps.push(this.paymentMethodStep(readiness, myRole, agreementId, agreement.relationshipId));

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

    // Step 5 — active: truthful post-signing payment-readiness/status state machine — see
    // activeStep's own doc comment. Never falls back to a generic "Waiting on other party".
    steps.push(
      await this.activeStep({
        status: agreement.status,
        myRole,
        agreementId,
        readiness,
        relationshipId: agreement.relationshipId,
        currency: agreement.currency,
      }),
    );

    const actionableForMeCount = steps.filter((s) => s.status === "action_required").length;
    const primaryAction = this.computePrimaryAction(steps, agreement.status);

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
  private async buildCancelledProgress(agreementId: string, myRole: PartyRole): Promise<AgreementProgress> {
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
      {
        key: "payment_method",
        label: "Payment method",
        status: "optional",
        description: "This agreement was cancelled. Payment setup is no longer relevant.",
        cta: null,
      },
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

  /**
   * Restore agreement payment functionality: computes the shared readiness snapshot once per
   * getProgress() call. Returns null both when there's no linked relationship *and* when one is
   * linked but the acting user's relationship-account read isn't resolvable — both degrade Step 3/5
   * to a safe, non-blocking default rather than failing the whole progress read (see class doc
   * comment). `paymentMethodStep` is given `relationshipId` separately so it can still tell these two
   * genuinely different cases apart — "no connection yet" (self-serve recoverable) vs. "connected, but
   * this read failed" (transient — must never invite creating a second, redundant connection).
   */
  private async computePaymentReadiness(
    relationshipId: string | null,
    agreementId: string,
    actingUserId: string,
  ): Promise<PaymentReadiness | null> {
    if (!relationshipId) return null;
    try {
      const accounts = await this.deps.relationshipPaymentMethods.getRelationshipAccounts(relationshipId, actingUserId);
      const hasActive = (usage: "funding" | "payout") =>
        accounts.some((a) => a.usage === usage && a.status === "active" && a.financialAccount.status !== "disabled");
      const debtorMandateActive = await this.deps.mandates.isActiveForAgreement(agreementId);
      return {
        debtorFundingAssigned: hasActive("funding"),
        debtorMandateActive,
        creditorPayoutReady: hasActive("payout"),
      };
    } catch {
      return null;
    }
  }

  /**
   * Step 3 — payment method. Never a bare "Optional": once a relationship is linked, each party sees
   * only their own actionable item (debtor funding-source setup vs. creditor payout-destination
   * setup) — a party is never sent into the other party's account setup, and once both are ready the
   * step reads "Complete", never leaving a stale "action required" chip after setup succeeds.
   *
   * Fix the "Make payment" button (mandatory command): `readiness === null` used to be read as "this
   * agreement genuinely doesn't need payment setup" and reported "optional"/"Not required" — that
   * assumption is false for any agreement created via the agreement-invitation ("Invite someone")
   * flow, which never links a relationship (AgreementInvitationService never calls
   * RelationshipService.linkAgreement) and therefore can never have a relationship-scoped funding or
   * payout account assigned. Reporting "optional" here previously let Step 5 (activeStep, below) fall
   * through and offer a "Make payment" CTA that could never lead to a working payment, since
   * AgreementDetail.tsx only renders the real payment panel once this step reads "complete" — a dead
   * button.
   *
   * Missing-connection UI remediation: no linked relationship (`relationshipId === null`) is a
   * normal, recoverable workflow state, never a dead end — AgreementInvitationService.acceptPlan now
   * links a connection automatically at acceptance time (see that method's own doc comment), so this
   * branch is reached only by an agreement predating that fix, or one from a creation path that
   * doesn't yet auto-link (B2BWorkflowService/CsvImportService — see docs/SPRINT_CONTROL.md's
   * known-limitations note). Either way, `action_required` (never `blocked`) plus a CTA into the
   * existing `MissingConnectionPanel` ("Create New Connection" / "Choose Existing Connection",
   * rendered on the agreement detail page) is the truthful, self-serve next step — never "Contact
   * support".
   *
   * A relationship *is* linked but `readiness` still came back null (the relationship-account read
   * itself failed) is a different, narrower case, kept as a distinct `blocked`/no-CTA state: showing
   * `MissingConnectionPanel` here would be actively wrong — it offers "Create New Connection", and
   * this agreement already has one; a fresh one would silently orphan the real link.
   */
  private paymentMethodStep(readiness: PaymentReadiness | null, myRole: PartyRole, agreementId: string, relationshipId: string | null): AgreementProgressStep {
    if (!readiness) {
      if (!relationshipId) {
        return {
          key: "payment_method",
          label: "Payment method",
          status: "action_required",
          statusText: "Connection required",
          description:
            myRole === "debtor"
              ? "This agreement isn't linked to a connection yet, so a funding account can't be assigned. Link or create a connection to continue."
              : "This agreement isn't linked to a connection yet, so a payout account can't be assigned. Link or create a connection to continue.",
          cta: { label: "Resolve connection", href: `/agreements/detail?id=${agreementId}#connection-required` },
        };
      }
      return {
        key: "payment_method",
        label: "Payment method",
        status: "blocked",
        statusText: "Payment setup temporarily unavailable",
        description: "We couldn't check this agreement's payment setup just now. Please try again shortly.",
        cta: null,
      };
    }
    const debtorReady = readiness.debtorFundingAssigned && readiness.debtorMandateActive;
    if (debtorReady && readiness.creditorPayoutReady) {
      return {
        key: "payment_method",
        label: "Payment method",
        status: "complete",
        statusText: "Payment method — Complete",
        description: "Payment accounts are ready for this agreement.",
        cta: null,
      };
    }
    if (myRole === "debtor") {
      if (!debtorReady) {
        return {
          key: "payment_method",
          label: "Payment method",
          status: "action_required",
          statusText: "Payment setup required",
          description: "Add a payment method so payments can be made under this agreement.",
          cta: {
            label: "Set up payment method",
            href: readiness.debtorFundingAssigned
              ? `/agreements/payment-authorize?id=${agreementId}`
              : "/payment-methods",
          },
        };
      }
      return {
        key: "payment_method",
        label: "Payment method",
        status: "waiting",
        statusText: "Waiting for creditor payout setup",
        description: "Your payment method is ready. Waiting for the creditor to set up a payout account.",
        cta: null,
      };
    }
    // myRole === "creditor"
    if (!readiness.creditorPayoutReady) {
      return {
        key: "payment_method",
        label: "Payment method",
        status: "action_required",
        statusText: "Payout setup required",
        description: "Add the account where you want to receive payments from this agreement.",
        cta: { label: "Set up payout account", href: "/payment-methods" },
      };
    }
    return {
      key: "payment_method",
      label: "Payment method",
      status: "waiting",
      statusText: "Waiting for debtor payment setup",
      description: "Your payout account is ready. Waiting for the debtor to set up a payment method.",
      cta: null,
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

  /**
   * Step 5 — active. Restore agreement payment functionality: once both parties have signed, this
   * step must never read a generic "Waiting on other party" — it derives the exact truthful status
   * (payment setup required / payout setup required / waiting on the other party's setup / payment
   * processing / payment failed — action required / payment due / next payment scheduled / paid in
   * full) from the shared PaymentReadiness snapshot plus the live installment/payment-attempt state.
   * "mutually_canceled" is deliberately not handled here — getProgress returns via
   * buildCancelledProgress before this method is ever reached for that status.
   */
  private async activeStep(input: {
    status: AgreementStatus;
    myRole: PartyRole;
    agreementId: string;
    readiness: PaymentReadiness | null;
    relationshipId: string | null;
    currency: string;
  }): Promise<AgreementProgressStep> {
    const { status, myRole, agreementId, readiness, relationshipId, currency } = input;

    if (status === "paid_in_full" || status === "settled_in_full") {
      return {
        key: "active",
        label: "Agreement active",
        status: "complete",
        statusText: "Agreement paid in full",
        description: "This agreement is complete.",
        cta: null,
      };
    }
    if (status === "disputed" || status === "paused_by_amendment" || status === "closed") {
      return {
        key: "active",
        label: "Agreement active",
        status: "blocked",
        description: STATUS_LABELS[status],
        cta: null,
      };
    }

    const signedStates: AgreementStatus[] = ["first_payment_pending", "active", "past_due"];
    if (!signedStates.includes(status)) {
      return {
        key: "active",
        label: "Agreement active",
        status: "not_started",
        description: "Not yet reached.",
        cta: null,
      };
    }

    // Fix the "Make payment" button (mandatory command): `readiness === null` used to be treated as
    // "payment readiness genuinely doesn't apply — fall through to a plain 'Make payment' CTA below."
    // That was wrong: every real path that reaches "active" status needs a real funding/payout
    // account, and AgreementDetail.tsx's payment panel only ever renders once `payment_method` reads
    // "complete" — which a null-readiness agreement (no linked relationship) can never reach. Treating
    // null the same as "not ready" here means Step 5 always matches what the debtor can actually do —
    // never a "Make payment" CTA pointing at a panel that will never exist.
    if (!readiness || !readiness.debtorFundingAssigned || !readiness.debtorMandateActive || !readiness.creditorPayoutReady) {
      // Reuses paymentMethodStep's own role-specific wording — the exact same missing requirement
      // that blocks Step 3 is what "Agreement active" is truthfully waiting on here too.
      const pm = this.paymentMethodStep(readiness, myRole, agreementId, relationshipId);
      return { ...pm, key: "active", label: "Agreement active" };
    }

    const installments = await this.deps.installments.listForAgreement(agreementId);
    const nextUnpaid = installments.find((i) => i.status !== "paid" && i.status !== "waived");
    if (!nextUnpaid) {
      return {
        key: "active",
        label: "Agreement active",
        status: "complete",
        statusText: "Agreement paid in full",
        description: "All scheduled payments are complete.",
        cta: null,
      };
    }

    const attempts = await this.deps.paymentAttempts.listByAgreementId(agreementId);
    const relevantAttempts = attempts
      .filter((a) => a.installmentScheduleItemId === nextUnpaid.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const openAttempt = relevantAttempts.find((a) => OPEN_PAYMENT_ATTEMPT_STATUSES.has(a.status));
    if (openAttempt) {
      return {
        key: "active",
        label: "Agreement active",
        status: "waiting",
        statusText: "Payment processing",
        description: myRole === "debtor" ? "Your payment is processing." : "A payment from the debtor is processing.",
        cta: null,
      };
    }

    const lastAttempt = relevantAttempts[0];
    if (lastAttempt && FAILED_PAYMENT_ATTEMPT_STATUSES.has(lastAttempt.status)) {
      if (myRole === "debtor") {
        return {
          key: "active",
          label: "Agreement active",
          status: "action_required",
          statusText: "Payment failed — action required",
          description: lastAttempt.failureReason
            ? `Your last payment attempt failed: ${lastAttempt.failureReason}. Please try again.`
            : "Your last payment attempt failed. Please try again.",
          cta: { label: "Make payment", href: `/agreements/detail?id=${agreementId}#make-payment` },
        };
      }
      return {
        key: "active",
        label: "Agreement active",
        status: "waiting",
        statusText: "Payment not yet completed",
        description: "The debtor's last payment attempt failed. They've been notified.",
        cta: null,
      };
    }

    const amount = formatMoney(nextUnpaid.amountMinorUnits, currency);
    const overdue = isPastDate(nextUnpaid.dueDate);
    const remainingSuffix = await this.remainingBalanceSuffix(agreementId, currency);
    if (myRole === "debtor") {
      return {
        key: "active",
        label: "Agreement active",
        status: overdue ? "action_required" : "waiting",
        statusText: overdue ? "Payment due" : "Next payment scheduled",
        description: `Payment of ${amount} is due ${nextUnpaid.dueDate}.${remainingSuffix}`,
        cta: { label: "Make payment", href: `/agreements/detail?id=${agreementId}#make-payment` },
      };
    }
    return {
      key: "active",
      label: "Agreement active",
      status: "waiting",
      statusText: "Next payment scheduled",
      description: `Next payment of ${amount} from the debtor is due ${nextUnpaid.dueDate}.${remainingSuffix}`,
      cta: null,
    };
  }

  /** Restore agreement payment functionality: read-only, best-effort — a balance lookup failure (e.g. no signed version yet, which shouldn't be reachable here but is defended anyway) just omits the suffix rather than failing the whole progress read. */
  private async remainingBalanceSuffix(agreementId: string, currency: string): Promise<string> {
    try {
      const { remainingBalanceMinorUnits } = await this.deps.balance.getAgreementBalance(agreementId);
      return ` Remaining balance: ${formatMoney(remainingBalanceMinorUnits, currency)}.`;
    } catch {
      return "";
    }
  }

  private computePrimaryAction(steps: AgreementProgressStep[], status: AgreementStatus): AgreementPrimaryAction {
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
      // Restore agreement payment functionality: "Waiting for other party" is now only ever a
      // fallback for the pre-existing acceptance/signatures waiting cases, which don't set
      // statusText — every payment-readiness waiting state (payout setup, payment processing, next
      // payment scheduled, ...) supplies its own truthful statusText instead.
      return { label: waiting.statusText ?? "Waiting for other party", description: waiting.description, cta: null };
    }
    if (status === "paid_in_full" || status === "settled_in_full") {
      return { label: "Agreement complete", description: "This agreement is complete.", cta: null };
    }
    return { label: "No action needed", description: "Nothing requires your attention right now.", cta: null };
  }
}
