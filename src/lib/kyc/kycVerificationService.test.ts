import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "@/lib/errors";
import { createTestKycServices } from "./testFakes";

const PROFILE_ID = "profile-1";
const BUSINESS_ID = "biz-1";

describe("KycVerificationService", () => {
  let ctx: ReturnType<typeof createTestKycServices>;

  beforeEach(() => {
    ctx = createTestKycServices();
  });

  it("submits an individual verification, creating a pending Sprint 3 record with a provider reference attached", async () => {
    const result = await ctx.kycVerificationService.submitIndividualVerification({
      profileId: PROFILE_ID,
      legalName: "Jane Doe",
      dateOfBirth: "1990-01-01",
      governmentIdDocumentRef: "doc-1",
      selfieRef: "selfie-1",
    });
    expect(await ctx.verificationCtx.verificationService.getVerificationState("personal", PROFILE_ID)).toBe(
      "FULL_PENDING",
    );
    const record = await ctx.verificationCtx.records.findByProviderRef(result.providerVerificationId);
    expect(record?.profileId).toBe(PROFILE_ID);
  });

  it("submits a business verification the same way", async () => {
    const result = await ctx.kycVerificationService.submitBusinessVerification({
      profileId: BUSINESS_ID,
      legalBusinessName: "Acme LLC",
      registrationNumber: "REG-1",
      representativeGovernmentIdRef: "doc-2",
      bankAccountOwnershipRef: "bank-1",
    });
    expect(await ctx.verificationCtx.verificationService.getVerificationState("business", BUSINESS_ID)).toBe(
      "FULL_PENDING",
    );
    expect(await ctx.verificationCtx.records.findByProviderRef(result.providerVerificationId)).not.toBeNull();
  });

  it("rejects a duplicate verification submission while one is already pending", async () => {
    await ctx.kycVerificationService.submitIndividualVerification({
      profileId: PROFILE_ID,
      legalName: "Jane Doe",
      dateOfBirth: "1990-01-01",
      governmentIdDocumentRef: "doc-1",
      selfieRef: "selfie-1",
    });
    await expect(
      ctx.kycVerificationService.submitIndividualVerification({
        profileId: PROFILE_ID,
        legalName: "Jane Doe",
        dateOfBirth: "1990-01-01",
        governmentIdDocumentRef: "doc-1-retry",
        selfieRef: "selfie-1-retry",
      }),
    ).rejects.toThrow(ConflictError);
  });
});
