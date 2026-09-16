import { beforeEach, describe, expect, it } from "vitest";
import { ProviderNotAvailableError } from "@/lib/errors";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import { DrizzlePaymentInitiationEligibilityService } from "./paymentInitiationEligibilityService";
import { InMemoryPaymentAttemptRepository } from "./testFakes";

const PAYER = { profileKind: "personal" as const, profileId: "payer-1" };
const RECIPIENT = { profileKind: "business" as const, profileId: "recipient-1" };
const REVIEWER_USER_ID = "reviewer-1";

/**
 * PAID2YOU — B0-D C2 (payment activation gate). This is the pre-lock control
 * `PaymentRetryService.fireDueRetries`'s atomic-coordinator branch — the ONLY path a real,
 * production-wired automatic retry takes (`getPaymentRetryService.ts` always supplies
 * `retryCoordinator`) — runs before dispatching a genuinely NEW retry attempt to the provider. See
 * `DrizzlePaymentInitiationEligibilityService`'s own doc comment on this field for exactly why it
 * defaults to `true` (this class's constructor has ~10 pre-existing postgres-integration-test call
 * sites this unit test intentionally does not touch) and why the ONE real production call site never
 * relies on that default.
 */
describe("DrizzlePaymentInitiationEligibilityService — B0-D C2 payment activation gate", () => {
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

  it("defaults to NOT gating (pre-existing postgres-integration-test call sites stay unaffected)", async () => {
    const eligibility = new DrizzlePaymentInitiationEligibilityService({
      verification: verificationCtx.verificationService,
      payments,
    });
    await expect(eligibility.assertPreLockEligible({ payer: PAYER, recipient: RECIPIENT, amountMinorUnits: 5_000 })).resolves.toBeUndefined();
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

  it("newPaymentInitiationVerified: true (the real ADYEN_PAYMENTS_VERIFIED=true production wiring) allows a new retry dispatch through", async () => {
    const eligibility = new DrizzlePaymentInitiationEligibilityService({
      verification: verificationCtx.verificationService,
      payments,
      newPaymentInitiationVerified: true,
    });
    await expect(eligibility.assertPreLockEligible({ payer: PAYER, recipient: RECIPIENT, amountMinorUnits: 5_000 })).resolves.toBeUndefined();
  });
});
