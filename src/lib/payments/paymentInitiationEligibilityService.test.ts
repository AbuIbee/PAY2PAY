import { beforeEach, describe, expect, it } from "vitest";
import { ProviderNotAvailableError } from "@/lib/errors";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import { DrizzlePaymentInitiationEligibilityService } from "./paymentInitiationEligibilityService";
import { InMemoryPaymentAttemptRepository } from "./testFakes";

const PAYER = { profileKind: "personal" as const, profileId: "payer-1" };
const RECIPIENT = { profileKind: "business" as const, profileId: "recipient-1" };
const REVIEWER_USER_ID = "reviewer-1";

/**
 * Payment activation gate (SC-10). This is the pre-lock control
 * `PaymentRetryService.fireDueRetries`'s atomic-coordinator branch — the ONLY path a real,
 * production-wired automatic retry takes (`getPaymentRetryService.ts` always supplies
 * `retryCoordinator`) — runs before dispatching a genuinely NEW retry attempt to the provider.
 *
 * REM-008: `newPaymentInitiationVerified` is required (no permissive default) — see
 * `DrizzlePaymentInitiationEligibilityService`'s own doc comment on this field for why an optional,
 * defaulting-to-verified field was a real fail-open risk. Every call site (including every
 * postgres-integration test) now passes an explicit value.
 */
describe("DrizzlePaymentInitiationEligibilityService — payment activation gate (SC-10)", () => {
  let verificationCtx: ReturnType<typeof createTestVerificationService>;
  let payments: InMemoryPaymentAttemptRepository;

  beforeEach(async () => {
    verificationCtx = createTestVerificationService();
    payments = new InMemoryPaymentAttemptRepository();
    for (const ref of [PAYER, RECIPIENT]) {
      await verificationCtx.verificationService.submitFullVerificationRequest(ref.profileKind, ref.profileId);
      await verificationCtx.verificationService.recordManualVerificationDecision({
        actingRole: "platform_owner",
        profileKind: ref.profileKind,
        profileId: ref.profileId,
        decision: "verified",
        reviewerUserId: REVIEWER_USER_ID,
        reason: null,
      });
    }
  });

  it("REM-008: there is no permissive default — TypeScript itself requires newPaymentInitiationVerified to be supplied explicitly (this test documents that constraint; see the two tests below for both explicit values)", () => {
    // @ts-expect-error — newPaymentInitiationVerified is required; omitting it must not compile.
    const attempt = () => new DrizzlePaymentInitiationEligibilityService({ verification: verificationCtx.verificationService, payments });
    expect(attempt).toBeDefined();
  });

  it("newPaymentInitiationVerified: false blocks a genuinely NEW automatic retry dispatch before the provider is ever called", async () => {
    const eligibility = new DrizzlePaymentInitiationEligibilityService({
      verification: verificationCtx.verificationService,
      payments,
      newPaymentInitiationVerified: false,
    });
    await expect(eligibility.assertPreLockEligible({ payer: PAYER, recipient: RECIPIENT, amountMinorUnits: 5_000 })).rejects.toThrow(
      ProviderNotAvailableError,
    );
  });

  it("newPaymentInitiationVerified: true (the real PAYMENT_INITIATION_VERIFIED=true production wiring) allows a new retry dispatch through", async () => {
    const eligibility = new DrizzlePaymentInitiationEligibilityService({
      verification: verificationCtx.verificationService,
      payments,
      newPaymentInitiationVerified: true,
    });
    await expect(eligibility.assertPreLockEligible({ payer: PAYER, recipient: RECIPIENT, amountMinorUnits: 5_000 })).resolves.toBeUndefined();
  });
});
