import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { SandboxKycProvider } from "./sandboxKycProvider";

const SECRET = "sandbox-kyc-provider-test-secret";

describe("SandboxKycProvider (provider adapter)", () => {
  it("starts an individual verification as pending", async () => {
    const provider = new SandboxKycProvider(SECRET);
    const result = await provider.submitIndividualVerification({
      profileId: "profile-1",
      legalName: "Jane Doe",
      dateOfBirth: "1990-01-01",
      governmentIdDocumentRef: "doc-ref-1",
      selfieRef: "selfie-ref-1",
    });
    expect(result.providerVerificationId).toMatch(/^sandbox_kyc_/);
    expect((await provider.retrieveVerificationStatus(result.providerVerificationId)).status).toBe("pending");
  });

  it("starts a business verification as pending", async () => {
    const provider = new SandboxKycProvider(SECRET);
    const result = await provider.submitBusinessVerification({
      profileId: "biz-1",
      legalBusinessName: "Acme LLC",
      registrationNumber: "REG-1",
      representativeGovernmentIdRef: "doc-ref-2",
      bankAccountOwnershipRef: "bank-ref-1",
    });
    expect((await provider.retrieveVerificationStatus(result.providerVerificationId)).status).toBe("pending");
  });

  it("rejects retrieving an unknown verification id", async () => {
    const provider = new SandboxKycProvider(SECRET);
    await expect(provider.retrieveVerificationStatus("unknown")).rejects.toThrow(ValidationError);
  });

  it("simulateDecision moves a known verification to approved/declined", async () => {
    const provider = new SandboxKycProvider(SECRET);
    const { providerVerificationId } = await provider.submitIndividualVerification({
      profileId: "profile-2",
      legalName: "John Roe",
      dateOfBirth: "1985-05-05",
      governmentIdDocumentRef: "doc-ref-3",
      selfieRef: "selfie-ref-2",
    });
    provider.simulateDecision(providerVerificationId, "approved");
    expect((await provider.retrieveVerificationStatus(providerVerificationId)).status).toBe("approved");
  });

  it("accepts a correctly-signed webhook and rejects a spoofed one", () => {
    const provider = new SandboxKycProvider(SECRET);
    const attacker = new SandboxKycProvider("different-secret");
    const rawBody = JSON.stringify({ providerEventId: "evt_1", eventType: "verification.approved" });

    const genuine = provider.signWebhookPayload(rawBody);
    expect(provider.verifyWebhookSignature(rawBody, genuine)).toBe(true);

    const spoofed = attacker.signWebhookPayload(rawBody);
    expect(provider.verifyWebhookSignature(rawBody, spoofed)).toBe(false);
  });

  it("parses a valid webhook payload and rejects malformed ones", () => {
    const provider = new SandboxKycProvider(SECRET);
    const rawBody = JSON.stringify({ providerEventId: "evt_2", eventType: "verification.approved", providerVerificationId: "sandbox_kyc_x" });
    const parsed = provider.parseWebhookEvent(rawBody);
    expect(parsed).toMatchObject({ provider: "sandbox_kyc_mock", providerEventId: "evt_2", eventType: "verification.approved" });
    expect(() => provider.parseWebhookEvent("not json")).toThrow(ValidationError);
  });
});
