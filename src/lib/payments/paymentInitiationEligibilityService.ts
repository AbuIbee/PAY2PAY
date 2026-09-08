import "server-only";
import { DependencyError, ValidationError } from "@/lib/errors";
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
   * configured per-payment maximum, the rolling-window daily amount/attempt-count limits, and current
   * full-verification status for both parties. Deliberately omits `reserveAttempt`'s payer-ownership
   * and agreement-parties cross-checks — both are tautological for a system-initiated retry (its
   * `actingUserId` is always derived FROM the original payment's own payer, and the agreement/parties
   * were already validated when the ORIGINAL payment was created). Throws exactly as `reserveAttempt`
   * would (`DependencyError`/`ValidationError`).
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
    },
  ) {}

  async assertPreLockEligible(input: { payer: ProfileRef; recipient: ProfileRef; amountMinorUnits: number }): Promise<void> {
    if (!isFeatureEnabled("paymentInitiationEnabled")) {
      throw new DependencyError("New payment initiation is temporarily disabled. Please try again shortly.");
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
