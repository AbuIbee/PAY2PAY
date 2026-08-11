import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { createTestKycServices } from "./testFakes";

const PROFILE_ID = "profile-1";

describe("KycWebhookService", () => {
  let ctx: ReturnType<typeof createTestKycServices>;

  beforeEach(() => {
    ctx = createTestKycServices();
  });

  async function submitAndGetProviderRef(): Promise<string> {
    const { providerVerificationId } = await ctx.kycVerificationService.submitIndividualVerification({
      profileId: PROFILE_ID,
      legalName: "Jane Doe",
      dateOfBirth: "1990-01-01",
      governmentIdDocumentRef: "doc-1",
      selfieRef: "selfie-1",
    });
    return providerVerificationId;
  }

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: ctx.provider.signWebhookPayload(rawBody) };
  }

  it("rejects a spoofed webhook signature", async () => {
    const rawBody = JSON.stringify({ providerEventId: "evt_spoof", eventType: "verification.approved" });
    await expect(
      ctx.kycWebhookService.receiveWebhook({ rawBody, signatureHeader: "0".repeat(64) }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("moves FULL_PENDING to FULL_VERIFIED on a verification.approved event", async () => {
    const providerVerificationId = await submitAndGetProviderRef();
    const { rawBody, signatureHeader } = signedWebhook({
      providerEventId: "evt_1",
      eventType: "verification.approved",
      providerVerificationId,
    });
    const result = await ctx.kycWebhookService.receiveWebhook({ rawBody, signatureHeader });
    expect(result.status).toBe("processed");
    expect(await ctx.verificationCtx.verificationService.getVerificationState("personal", PROFILE_ID)).toBe(
      "FULL_VERIFIED",
    );
    expect(await ctx.verificationCtx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(true);
  });

  it("moves FULL_PENDING to FULL_REJECTED on a verification.declined event; profile stays gated", async () => {
    const providerVerificationId = await submitAndGetProviderRef();
    const { rawBody, signatureHeader } = signedWebhook({
      providerEventId: "evt_2",
      eventType: "verification.declined",
      providerVerificationId,
      reason: "Document mismatch.",
    });
    await ctx.kycWebhookService.receiveWebhook({ rawBody, signatureHeader });
    expect(await ctx.verificationCtx.verificationService.getVerificationState("personal", PROFILE_ID)).toBe(
      "FULL_REJECTED",
    );
    expect(await ctx.verificationCtx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
  });

  it("keeps the profile gated while still pending (no webhook received yet)", async () => {
    await submitAndGetProviderRef();
    expect(await ctx.verificationCtx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(false);
  });

  it("deduplicates a replayed decision event: second delivery is a no-op, reported as duplicate", async () => {
    const providerVerificationId = await submitAndGetProviderRef();
    const event = signedWebhook({ providerEventId: "evt_3", eventType: "verification.approved", providerVerificationId });

    const first = await ctx.kycWebhookService.receiveWebhook(event);
    expect(first.status).toBe("processed");
    const second = await ctx.kycWebhookService.receiveWebhook(event);
    expect(second.status).toBe("duplicate");
    expect(await ctx.verificationCtx.verificationService.getVerificationState("personal", PROFILE_ID)).toBe(
      "FULL_VERIFIED",
    );
  });

  it("does not fail on a late decision event for an already-decided verification (distinct providerEventId)", async () => {
    const providerVerificationId = await submitAndGetProviderRef();
    const approve = signedWebhook({ providerEventId: "evt_4a", eventType: "verification.approved", providerVerificationId });
    await ctx.kycWebhookService.receiveWebhook(approve);

    const lateDecline = signedWebhook({ providerEventId: "evt_4b", eventType: "verification.declined", providerVerificationId });
    const result = await ctx.kycWebhookService.receiveWebhook(lateDecline);
    expect(result.status).toBe("processed");
    // The original approval is not overwritten by the late/duplicate decision.
    expect(await ctx.verificationCtx.verificationService.isFullyVerified("personal", PROFILE_ID)).toBe(true);
  });
});
