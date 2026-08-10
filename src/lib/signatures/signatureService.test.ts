import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { hashPdfContent } from "@/lib/documents/agreementPdf";
import { createTestSignatureService, grantStepUp, markFullyVerified, seedPersonalParty } from "./testFakes";

function baseTerms(overrides: Partial<DraftTermsInput> = {}): DraftTermsInput {
  return {
    category: "personal_loan",
    description: "Loan for car repair",
    originalAmountMinorUnits: 120_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 20_000,
    installmentAmountMinorUnits: 20_000,
    frequency: "monthly",
    firstPaymentDate: "2026-02-01",
    feeAllocation: "debtor_pays",
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Borrower may request hardship relief; no interest or penalty added.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

const CONSENT = "2026-08-10-v1";
const TZ = "America/New_York";

describe("SignatureService", () => {
  let ctx: ReturnType<typeof createTestSignatureService>;

  beforeEach(() => {
    ctx = createTestSignatureService();
  });

  async function setupPersonalAwaitingSignatures() {
    const creditorUserId = randomUUID();
    const debtorUserId = randomUUID();
    const creditorProfileId = await seedPersonalParty(ctx, creditorUserId);
    const debtorProfileId = await seedPersonalParty(ctx, debtorUserId);

    const created = await ctx.agreementCtx.agreementService.createDraft({
      creatorUserId: creditorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    await ctx.agreementCtx.agreementService.submitDraft(created.agreement.id, creditorUserId);
    await ctx.agreementCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
    await ctx.agreementCtx.agreementService.creditorDecide({
      agreementId: created.agreement.id,
      actingUserId: creditorUserId,
      decision: "accept",
    });

    return { agreementId: created.agreement.id, versionId: created.version.id, creditorUserId, debtorUserId, creditorProfileId, debtorProfileId };
  }

  async function readySigner(userId: string, sessionId: string, personalProfileId: string) {
    await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, userId, sessionId);
    await markFullyVerified(ctx, "personal", personalProfileId);
  }

  describe("signature authorization", () => {
    it("records a full evidence bundle for an authorized, verified, stepped-up signer", async () => {
      const setup = await setupPersonalAwaitingSignatures();
      const sessionId = randomUUID();
      await readySigner(setup.creditorUserId, sessionId, setup.creditorProfileId);

      const result = await ctx.signatureService.sign({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        actingSessionId: sessionId,
        authMethod: "totp",
        consentVersion: CONSENT,
        timezone: TZ,
        deviceInfo: { userAgent: "vitest" },
        ipAddress: "203.0.113.10",
      });

      expect(result.agreementStatus).toBe("awaiting_signatures"); // only one party has signed
      expect(result.pdfGenerated).toBe(false);
      expect(result.signatureEvent.signerRole).toBe("creditor");
      expect(result.signatureEvent.signerProfileKind).toBe("personal");
      expect(result.signatureEvent.signerProfileId).toBe(setup.creditorProfileId);
      expect(result.signatureEvent.consentCaptured).toBe(true);
      expect(result.signatureEvent.consentVersion).toBe(CONSENT);
      expect(result.signatureEvent.authMethod).toBe("totp");
      expect(result.signatureEvent.ipAddress).toBe("203.0.113.10");
      expect(result.signatureEvent.timezone).toBe(TZ);
      expect(result.signatureEvent.agreementHashAtSigning).toBeTruthy();
      expect(result.signatureEvent.signingAuthority).toBeNull(); // personal signer, not business
    });
  });

  describe("second-party signature", () => {
    it("both parties signing transitions the agreement and generates the PDF exactly once", async () => {
      const setup = await setupPersonalAwaitingSignatures();
      const creditorSession = randomUUID();
      const debtorSession = randomUUID();
      await readySigner(setup.creditorUserId, creditorSession, setup.creditorProfileId);
      await readySigner(setup.debtorUserId, debtorSession, setup.debtorProfileId);

      const first = await ctx.signatureService.sign({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        actingSessionId: creditorSession,
        authMethod: "totp",
        consentVersion: CONSENT,
        timezone: TZ,
        deviceInfo: null,
        ipAddress: "203.0.113.10",
      });
      expect(first.pdfGenerated).toBe(false);

      const second = await ctx.signatureService.sign({
        agreementId: setup.agreementId,
        actingUserId: setup.debtorUserId,
        actingSessionId: debtorSession,
        authMethod: "sms",
        consentVersion: CONSENT,
        timezone: TZ,
        deviceInfo: null,
        ipAddress: "203.0.113.20",
      });
      expect(second.agreementStatus).toBe("first_payment_pending");
      expect(second.pdfGenerated).toBe(true);
      expect(second.signatureEvent.signerRole).toBe("debtor");

      const events = await ctx.signatureEvents.listForVersion(setup.versionId);
      expect(events).toHaveLength(2);
    });
  });

  describe("unauthorized signer", () => {
    it("rejects a user with no relationship to either party", async () => {
      const setup = await setupPersonalAwaitingSignatures();
      const strangerUserId = randomUUID();
      const strangerSession = randomUUID();
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, strangerUserId, strangerSession);

      await expect(
        ctx.signatureService.sign({
          agreementId: setup.agreementId,
          actingUserId: strangerUserId,
          actingSessionId: strangerSession,
          authMethod: "totp",
          consentVersion: CONSENT,
          timezone: TZ,
          deviceInfo: null,
          ipAddress: "203.0.113.10",
        }),
      ).rejects.toThrow(ForbiddenError);

      expect(await ctx.signatureEvents.listForVersion(setup.versionId)).toHaveLength(0);
    });
  });

  describe("signing blocked without a passed step-up challenge", () => {
    it("rejects signing when no fresh step-up exists for the session, even for a verified party", async () => {
      const setup = await setupPersonalAwaitingSignatures();
      await markFullyVerified(ctx, "personal", setup.creditorProfileId);
      // Deliberately no grantStepUp call.

      await expect(
        ctx.signatureService.sign({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          actingSessionId: randomUUID(),
          authMethod: "totp",
          consentVersion: CONSENT,
          timezone: TZ,
          deviceInfo: null,
          ipAddress: "203.0.113.10",
        }),
      ).rejects.toThrow(ForbiddenError);

      expect(await ctx.signatureEvents.listForVersion(setup.versionId)).toHaveLength(0);
      const agreement = await ctx.agreementCtx.agreements.findById(setup.agreementId);
      expect(agreement?.status).toBe("awaiting_signatures"); // signAgreement was never reached
    });
  });

  describe("signing blocked when signer profile is not FULL_VERIFIED", () => {
    it("rejects signing when the signer's own personal profile is not fully verified", async () => {
      const setup = await setupPersonalAwaitingSignatures();
      const sessionId = randomUUID();
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, setup.creditorUserId, sessionId);
      // Deliberately no markFullyVerified call.

      await expect(
        ctx.signatureService.sign({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          actingSessionId: sessionId,
          authMethod: "totp",
          consentVersion: CONSENT,
          timezone: TZ,
          deviceInfo: null,
          ipAddress: "203.0.113.10",
        }),
      ).rejects.toThrow(ValidationError);

      expect(await ctx.signatureEvents.listForVersion(setup.versionId)).toHaveLength(0);
    });
  });

  describe("signing blocked when business profile is not FULL_VERIFIED (business signer)", () => {
    it("rejects a business-owner signer when the business profile itself is not fully verified", async () => {
      const ownerUserId = randomUUID();
      const debtorUserId = randomUUID();
      const businessId = randomUUID();
      ctx.agreementCtx.profileOwners.set("business", businessId, ownerUserId);
      const debtorProfileId = await seedPersonalParty(ctx, debtorUserId);

      const created = await ctx.agreementCtx.agreementService.createDraft({
        creatorUserId: ownerUserId,
        creditor: { kind: "business", id: businessId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.agreementCtx.agreementService.submitDraft(created.agreement.id, ownerUserId);
      await ctx.agreementCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await ctx.agreementCtx.agreementService.creditorDecide({
        agreementId: created.agreement.id,
        actingUserId: ownerUserId,
        decision: "accept",
      });

      const sessionId = randomUUID();
      const ownerPersonalProfileId = await seedPersonalParty(ctx, ownerUserId);
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, ownerUserId, sessionId);
      await markFullyVerified(ctx, "personal", ownerPersonalProfileId);
      // Deliberately: the business profile itself is never marked FULL_VERIFIED.

      await expect(
        ctx.signatureService.sign({
          agreementId: created.agreement.id,
          actingUserId: ownerUserId,
          actingSessionId: sessionId,
          authMethod: "totp",
          consentVersion: CONSENT,
          timezone: TZ,
          deviceInfo: null,
          ipAddress: "203.0.113.10",
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("business signer authority", () => {
    async function setupBusinessAwaitingSignatures() {
      const ownerUserId = randomUUID();
      const debtorUserId = randomUUID();
      const businessId = randomUUID();
      ctx.agreementCtx.profileOwners.set("business", businessId, ownerUserId);
      const debtorProfileId = await seedPersonalParty(ctx, debtorUserId);

      const created = await ctx.agreementCtx.agreementService.createDraft({
        creatorUserId: ownerUserId,
        creditor: { kind: "business", id: businessId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.agreementCtx.agreementService.submitDraft(created.agreement.id, ownerUserId);
      await ctx.agreementCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await ctx.agreementCtx.agreementService.creditorDecide({
        agreementId: created.agreement.id,
        actingUserId: ownerUserId,
        decision: "accept",
      });
      await markFullyVerified(ctx, "business", businessId);
      return { agreementId: created.agreement.id, versionId: created.version.id, ownerUserId, businessId };
    }

    it("allows the business owner to sign with signingAuthority 'account_owner'", async () => {
      const setup = await setupBusinessAwaitingSignatures();
      const sessionId = randomUUID();
      const ownerPersonalProfileId = await seedPersonalParty(ctx, setup.ownerUserId);
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, setup.ownerUserId, sessionId);
      await markFullyVerified(ctx, "personal", ownerPersonalProfileId);

      const result = await ctx.signatureService.sign({
        agreementId: setup.agreementId,
        actingUserId: setup.ownerUserId,
        actingSessionId: sessionId,
        authMethod: "totp",
        consentVersion: CONSENT,
        timezone: TZ,
        deviceInfo: null,
        ipAddress: "203.0.113.10",
      });
      expect(result.signatureEvent.signingAuthority).toBe("account_owner");
      expect(result.signatureEvent.signerTitle).toBeNull();
    });

    it("rejects a staff member who is not an authorized representative", async () => {
      const setup = await setupBusinessAwaitingSignatures();
      const staffUserId = randomUUID();
      ctx.agreementCtx.staffCtx.staffMembers.seed({
        businessProfileId: setup.businessId,
        userId: staffUserId,
        role: "manager",
        isAuthorizedRepresentative: false,
      });
      const sessionId = randomUUID();
      const staffPersonalProfileId = await seedPersonalParty(ctx, staffUserId);
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, staffUserId, sessionId);
      await markFullyVerified(ctx, "personal", staffPersonalProfileId);

      await expect(
        ctx.signatureService.sign({
          agreementId: setup.agreementId,
          actingUserId: staffUserId,
          actingSessionId: sessionId,
          authMethod: "totp",
          consentVersion: CONSENT,
          timezone: TZ,
          deviceInfo: null,
          ipAddress: "203.0.113.10",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("allows a staff member who is an authorized representative, recording their title", async () => {
      const setup = await setupBusinessAwaitingSignatures();
      const staffUserId = randomUUID();
      ctx.agreementCtx.staffCtx.staffMembers.seed({
        businessProfileId: setup.businessId,
        userId: staffUserId,
        role: "manager",
        isAuthorizedRepresentative: true,
      });
      const sessionId = randomUUID();
      const staffPersonalProfileId = await seedPersonalParty(ctx, staffUserId);
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, staffUserId, sessionId);
      await markFullyVerified(ctx, "personal", staffPersonalProfileId);

      const result = await ctx.signatureService.sign({
        agreementId: setup.agreementId,
        actingUserId: staffUserId,
        actingSessionId: sessionId,
        authMethod: "totp",
        consentVersion: CONSENT,
        timezone: TZ,
        deviceInfo: null,
        ipAddress: "203.0.113.10",
      });
      expect(result.signatureEvent.signingAuthority).toBe("authorized_representative");
      expect(result.signatureEvent.signerTitle).toBe("manager");
    });
  });

  describe("PDF generated / hash stability / document access isolation", () => {
    async function signBothParties() {
      const setup = await setupPersonalAwaitingSignatures();
      const creditorSession = randomUUID();
      const debtorSession = randomUUID();
      await readySigner(setup.creditorUserId, creditorSession, setup.creditorProfileId);
      await readySigner(setup.debtorUserId, debtorSession, setup.debtorProfileId);
      await ctx.signatureService.sign({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        actingSessionId: creditorSession,
        authMethod: "totp",
        consentVersion: CONSENT,
        timezone: TZ,
        deviceInfo: null,
        ipAddress: "203.0.113.10",
      });
      await ctx.signatureService.sign({
        agreementId: setup.agreementId,
        actingUserId: setup.debtorUserId,
        actingSessionId: debtorSession,
        authMethod: "sms",
        consentVersion: CONSENT,
        timezone: TZ,
        deviceInfo: null,
        ipAddress: "203.0.113.20",
      });
      return setup;
    }

    it("generates exactly one PDF whose stored hash matches its stored bytes", async () => {
      const setup = await signBothParties();
      const pdfRecord = await ctx.agreementPdfs.findByVersion(setup.versionId);
      expect(pdfRecord).not.toBeNull();
      const storedBytes = ctx.storage.read(pdfRecord!.storagePath);
      expect(storedBytes).toBeDefined();
      expect(hashPdfContent(storedBytes!)).toBe(pdfRecord!.documentHash);
    });

    it("hash stability: re-hashing the same stored bytes always yields the same hash, and the document is never overwritten", async () => {
      const setup = await signBothParties();
      const pdfRecord = await ctx.agreementPdfs.findByVersion(setup.versionId);
      const bytes = ctx.storage.read(pdfRecord!.storagePath)!;
      expect(hashPdfContent(bytes)).toBe(hashPdfContent(bytes));
      expect(hashPdfContent(bytes)).toBe(pdfRecord!.documentHash);
      // The fake throws on any attempt to write the same immutable path twice.
      await expect(
        ctx.storage.uploadPrivate({ path: pdfRecord!.storagePath, content: bytes, contentType: "application/pdf" }),
      ).rejects.toThrow();
    });

    it("document access isolation: both parties can retrieve a signed URL; a stranger cannot", async () => {
      const setup = await signBothParties();
      const creditorUrl = await ctx.signatureService.getSignedPdfUrl(setup.agreementId, setup.creditorUserId);
      const debtorUrl = await ctx.signatureService.getSignedPdfUrl(setup.agreementId, setup.debtorUserId);
      expect(creditorUrl).toContain("signed");
      expect(debtorUrl).toContain("signed");

      await expect(ctx.signatureService.getSignedPdfUrl(setup.agreementId, randomUUID())).rejects.toThrow(ForbiddenError);
    });
  });

  describe("signed agreement cannot be edited", () => {
    it("terms remain unchanged and no counter is possible after both signatures", async () => {
      const setup = await setupPersonalAwaitingSignatures();
      const creditorSession = randomUUID();
      const debtorSession = randomUUID();
      await readySigner(setup.creditorUserId, creditorSession, setup.creditorProfileId);
      await readySigner(setup.debtorUserId, debtorSession, setup.debtorProfileId);
      await ctx.signatureService.sign({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        actingSessionId: creditorSession,
        authMethod: "totp",
        consentVersion: CONSENT,
        timezone: TZ,
        deviceInfo: null,
        ipAddress: "203.0.113.10",
      });
      await ctx.signatureService.sign({
        agreementId: setup.agreementId,
        actingUserId: setup.debtorUserId,
        actingSessionId: debtorSession,
        authMethod: "sms",
        consentVersion: CONSENT,
        timezone: TZ,
        deviceInfo: null,
        ipAddress: "203.0.113.20",
      });

      await expect(
        ctx.agreementCtx.agreementService.creditorDecide({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          decision: "counter",
          counterTerms: baseTerms({ installmentAmountMinorUnits: 1 }),
        }),
      ).rejects.toThrow(ValidationError);

      const version = await ctx.agreementCtx.versions.findById(setup.versionId);
      expect(version?.terms.installmentAmountMinorUnits).toBe(20_000);
      expect(version?.signedAt).not.toBeNull();
      expect(version?.documentHash).toBeTruthy();
    });
  });
});
