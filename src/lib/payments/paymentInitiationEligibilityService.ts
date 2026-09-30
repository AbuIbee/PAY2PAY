import "server-only";
import { DependencyError, ProviderNotAvailableError, ValidationError } from "@/lib/errors";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { getDailyAmountLimitMinorUnits, getDailyAttemptCountLimit, getMaxPaymentMinorUnits, getRollingWindowMs, summarizeRecentActivity } from "./transactionLimits";
import type { VerificationService } from "@/lib/profiles/verificationService";
import type { AgreementBalanceReader, PaymentAttemptRepository } from "./paymentService";
import type { ProfileRef } from "./paymentProvider";

/**
 * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 1). Extracted from
 * `PaymentService`'s own (formerly private) `assertNotOverpaying` — the SAME policy, never a second,
 * independently-maintained copy — so `FailedPaymentRetryCoordinator.claimAndExecuteRetry` can
 * re-validate it immediately before dispatching to the provider, while the installment lock is held
 * (the agreement's outstanding balance can change from a DIFFERENT, concurrently-completing payment).
 * `PaymentService.assertNotOverpaying` now delegates here unchanged.
 */
export async function assertNotOverpaying(
  balances: AgreementBalanceReader | undefined,
  agreementId: string,
  amountMinorUnits: number,
): Promise<void> {
  if (!balances) return;
  let balance: { remainingBalanceMinorUnits: number } | null;
  try {
    balance = await balances.getAgreementBalance(agreementId);
  } catch {
    return;
  }
  if (balance && amountMinorUnits > balance.remainingBalanceMinorUnits) {
    throw new ValidationError(
      `This payment of ${amountMinorUnits} minor units would exceed the agreement's remaining balance of ${balance.remainingBalanceMinorUnits} minor units. Overpayment is not permitted.`,
    );
  }
}

/**
 * PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 1): "the new retry transaction path
 * bypasses controls that previously lived in PaymentService.reserveAttempt." This is the single
 * reusable eligibility layer both `PaymentService.reserveAttempt` (a fresh, user-initiated payment)
 * and `FailedPaymentRetryCoordinator.claimAndExecuteRetry` (a system-initiated retry of a previously-
 * failed one) now consult, so a retry can never bypass any control a brand-new attempt would face —
 * never a duplicated, independently-drifting policy.
 *
 * Split into exactly the two sections Codex's own finding names:
 *   A. `assertPreLockEligible` — every check safe to run BEFORE any installment lock is acquired.
 *   B. `assertOverpaymentSafe` — MUST be re-validated while the lock is held, immediately before the
 *      provider is dispatched, because the underlying financial state (a DIFFERENT payment on the
 *      same agreement completing) can change concurrently in a way the installment lock alone does
 *      not serialize against (that would require agreement-level locking, out of this fix's scope —
 *      this narrows the window to immediately before dispatch, the latest point structurally
 *      available, rather than claiming perfect cross-installment atomicity).
 */
export interface PaymentInitiationEligibilityService {
  /**
   * Mirrors `PaymentService.reserveAttempt`'s own exact checks, in the same order, for the same
   * reasons (see that method's own doc comments): the platform payment-initiation kill switch, the
   * payment activation gate (`newPaymentInitiationVerified`), the configured per-payment maximum, the
   * rolling-window daily amount/attempt-count limits, and current full-verification status for both
   * parties. Deliberately omits `reserveAttempt`'s payer-ownership and agreement-parties cross-checks
   * — both are tautological for a system-initiated retry (its `actingUserId` is always derived FROM
   * the original payment's own payer, and the agreement/parties were already validated when the
   * ORIGINAL payment was created). Throws exactly as `reserveAttempt` would
   * (`DependencyError`/`ValidationError`/`ProviderNotAvailableError`).
   */
  assertPreLockEligible(input: { payer: ProfileRef; recipient: ProfileRef; amountMinorUnits: number }): Promise<void>;
  /** See this interface's own doc comment, section B. Delegates to `assertNotOverpaying` above. */
  assertOverpaymentSafe(agreementId: string, amountMinorUnits: number): Promise<void>;
}

export class DrizzlePaymentInitiationEligibilityService implements PaymentInitiationEligibilityService {
  constructor(
    private readonly deps: {
      verification: VerificationService;
      payments: PaymentAttemptRepository;
      balances?: AgreementBalanceReader;
      /**
       * Payment activation gate (SC-10). This is the ONLY pre-lock control
       * `PaymentRetryService.fireDueRetries`'s atomic-coordinator branch runs before
       * `FailedPaymentRetryCoordinator.claimAndExecuteRetry` dispatches a genuinely NEW retry attempt
       * to the provider (see that method's own doc comment: every OTHER eligibility control is the
       * caller's responsibility to check BEFORE ever calling this method) — closing this gate here is
       * what actually blocks a brand-new automatic retry when no live provider is operator-verified.
       *
       * REM-008 correction: required (not optional) — an earlier version of this field was optional,
       * defaulting to "verified" when omitted. A configuration flag whose absence is silently treated
       * as "effective" is not an effective gate: any future call site that forgot to wire it would
       * fail OPEN rather than closed. Now every call site (including every pre-existing postgres
       * integration test) must make an explicit choice — mirrors `PaymentService`/`AchPaymentService`/
       * `DebitCardPaymentService`'s own identical required-field precedent for this exact flag. The
       * real production call site (`getPaymentRetryService.ts`) wires
       * `getServerEnv().PAYMENT_INITIATION_VERIFIED`. Never checked on `assertOverpaymentSafe`'s
       * resolution/resumption path (`resolveAmbiguousRetry` never calls this interface at all) —
       * resuming an already-possibly-dispatched, ambiguous attempt is recovery, never a new debit.
       */
      newPaymentInitiationVerified: boolean;
    },
  ) {}

  async assertPreLockEligible(input: { payer: ProfileRef; recipient: ProfileRef; amountMinorUnits: number }): Promise<void> {
    if (!isFeatureEnabled("paymentInitiationEnabled")) {
      throw new DependencyError("New payment initiation is temporarily disabled. Please try again shortly.");
    }
    // REM-008: fails closed on anything other than an explicit `true` — `false` AND an accidentally
    // omitted/undefined value are both treated as NOT verified, never merely `=== false`.
    if (this.deps.newPaymentInitiationVerified !== true) {
      throw new ProviderNotAvailableError(
        "New payment initiation requires PAYMENT_INITIATION_VERIFIED=true — provider registration and valid credentials alone do not constitute operator-confirmed approval to initiate live payments. See PAYMENT_INITIATION_VERIFIED's own doc comment in src/config/env.ts.",
      );
    }
    if (!Number.isSafeInteger(input.amountMinorUnits) || input.amountMinorUnits <= 0) {
      throw new ValidationError("amountMinorUnits must be a positive integer.");
    }
    if (input.amountMinorUnits > getMaxPaymentMinorUnits()) {
      throw new ValidationError("This payment exceeds the maximum amount currently allowed. Please contact support for a higher-value transfer.");
    }
    const since = new Date(Date.now() - getRollingWindowMs());
    const recent = await this.deps.payments.listRecentByPayer(input.payer, since);
    const activity = summarizeRecentActivity(recent);
    if (activity.amountMinorUnits + input.amountMinorUnits > getDailyAmountLimitMinorUnits()) {
      throw new ValidationError("This payment would exceed your daily transaction amount limit. Please try again later or contact support.");
    }
    if (activity.attemptCount + 1 > getDailyAttemptCountLimit()) {
      throw new ValidationError("You have reached your daily transaction attempt limit. Please try again later or contact support.");
    }
    const [payerVerified, recipientVerified] = await Promise.all([
      this.deps.verification.isFullyVerified(input.payer.profileKind, input.payer.profileId),
      this.deps.verification.isFullyVerified(input.recipient.profileKind, input.recipient.profileId),
    ]);
    if (!payerVerified) {
      throw new ValidationError("The payer must complete identity verification before a payment can be created.");
    }
    if (!recipientVerified) {
      throw new ValidationError("The recipient must complete identity verification before a payment can be created.");
    }
  }

  async assertOverpaymentSafe(agreementId: string, amountMinorUnits: number): Promise<void> {
    await assertNotOverpaying(this.deps.balances, agreementId, amountMinorUnits);
  }
}
