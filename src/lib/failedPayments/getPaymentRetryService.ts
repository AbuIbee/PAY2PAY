import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { getAchPaymentService } from "@/lib/ach/getAchPaymentService";
import { getDebitCardPaymentService } from "@/lib/debitCard/getDebitCardPaymentService";
import { getPaymentProvider } from "@/lib/payments/getPaymentProvider";
import { getPaymentWebhookService } from "@/lib/payments/getPaymentWebhookService";
import { DrizzlePaymentAttemptRepository } from "@/lib/payments/drizzlePaymentAttemptRepository";
import { DrizzlePaymentInitiationEligibilityService } from "@/lib/payments/paymentInitiationEligibilityService";
import { getVerificationService } from "@/lib/profiles/getVerificationService";
import { getBalanceService } from "@/lib/ledger/getBalanceService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { DrizzlePaymentRetryRepository } from "./drizzlePaymentRetryRepository";
import { getFailedPaymentRetryCoordinator } from "./getFailedPaymentRetryCoordinator";
import { PaymentRetryService } from "./paymentRetryService";

let cached: PaymentRetryService | null = null;

export function getPaymentRetryService(): PaymentRetryService {
  if (!cached) {
    cached = new PaymentRetryService({
      retries: new DrizzlePaymentRetryRepository(),
      paymentAttempts: new DrizzlePaymentAttemptRepository(),
      // PACKAGE B — remaining Codex blockers (3B): real production wiring always supplies the atomic
      // execution-claim coordinator — see FailedPaymentRetryCoordinator's own doc comment.
      retryCoordinator: getFailedPaymentRetryCoordinator(),
      // PAID2YOU — PACKAGE B (final retry-submission serialization): the SAME real provider instance
      // every payment method's own orchestration ultimately submits through — see
      // `PaymentRetryService`'s own doc comment on this dependency.
      provider: getPaymentProvider(),
      // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 1): the SAME reusable
      // eligibility layer PaymentService.reserveAttempt is built on.
      eligibility: new DrizzlePaymentInitiationEligibilityService({
        verification: getVerificationService(),
        payments: new DrizzlePaymentAttemptRepository(),
        balances: getBalanceService(),
      }),
      // PAID2YOU — PACKAGE B (Codex final remaining blockers, Section 2, and CRITICAL fix — Section
      // B1): the SAME singleton every real webhook delivery already processes through — see
      // `ProviderOutcomeEffectApplier`'s own doc comment. MUST be a lazy thunk, never
      // `getPaymentWebhookService()` invoked eagerly here: `getPaymentWebhookService()` ->
      // `getFailedPaymentWorkflowService()` -> `getPaymentRetryService()` is a REAL cycle back to
      // THIS exact function — and since this call happens while evaluating THIS constructor's own
      // arguments, `cached` above has not been assigned yet, so the recursive call would find it
      // still `null` and recurse forever (Codex independently proved this: RangeError: Maximum call
      // stack size exceeded). This wrapper's `receiveInternalEvent` method body only calls
      // `getPaymentWebhookService()` at ACTUAL invocation time — which never happens during this
      // module's own construction, only much later when a claimed/ambiguous retry is genuinely being
      // resolved, by which point `cached` here is already assigned, so any re-entrant call to
      // `getPaymentRetryService()` deeper in that call chain returns the cached instance immediately
      // instead of recursing. No global mutable placeholder, no partially-initialized singleton
      // mutation — just deferred evaluation of one dependency edge.
      effectApplier: {
        receiveInternalEvent: (input) => getPaymentWebhookService().receiveInternalEvent(input),
      },
      initiators: {
        ach: getAchPaymentService(),
        debit_card: getDebitCardPaymentService(),
        // PRSprint 18: a manual_off_platform attempt is created directly as "succeeded" (see
        // paymentService.ts's recordManualOffPlatformPayment) — it never fails and is never eligible
        // for an automatic retry, so this initiator exists only for Record<PaymentMethod, ...>
        // exhaustiveness and should structurally never be invoked.
        manual_off_platform: {
          async createManualPayment() {
            throw new Error("A manual off-platform payment can never fail and is never eligible for an automatic retry.");
          },
          async prepareRetrySubmission() {
            throw new Error("A manual off-platform payment can never fail and is never eligible for an automatic retry.");
          },
        },
      },
      profileOwners: new DrizzleProfileOwnerReader(),
      audit: new AuditService(new DrizzleAuditEventRepository()),
    });
  }
  return cached;
}
