import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AmendmentService } from "@/lib/amendments/amendmentService";
import { InMemoryAmendmentApplicationRepository, InMemoryAmendmentRepository } from "@/lib/amendments/testFakes";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { hashPdfContent } from "@/lib/documents/agreementPdf";
import { createTestSignatureService, grantStepUp, markFullyVerified, seedPersonalParty } from "./testFakes";

/** Minimal local fake — this test file's amendment-interaction test is the only caller. */
class InMemoryAmendmentAuditRepositoryForThisTest implements AuditEventRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;

  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events.at(-1) ?? null;
  }

  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const stored: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
}

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

  /**
   * PRSprint 12 (docs/prsprints/PRSPRINT_12_ELECTRONIC_SIGNATURES_PDFS_IMMUTABLE_RECORDS.md)
   * requirement #8: double-click/retry/replay must not create multiple legitimate signatures.
   */
  describe("idempotency / double-sign protection", () => {
    it("a second sign call from the same party after their own signature is cleanly rejected, and only one signature_event exists for that role", async () => {
      const setup = await setupPersonalAwaitingSignatures();
      const sessionId = randomUUID();
      await readySigner(setup.creditorUserId, sessionId, setup.creditorProfileId);
      const signOnce = () =>
        ctx.signatureService.sign({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          actingSessionId: sessionId,
          authMethod: "totp",
          consentVersion: CONSENT,
          timezone: TZ,
          deviceInfo: null,
          ipAddress: "203.0.113.10",
        });

      await signOnce();
      // Simulates a double-click/browser-retry/replayed request: the same party submits again.
      await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, setup.creditorUserId, sessionId);
      await expect(signOnce()).rejects.toThrow(ValidationError);

      const events = await ctx.signatureEvents.listForVersion(setup.versionId);
      expect(events.filter((e) => e.signerRole === "creditor")).toHaveLength(1);
    });

    it("repeated duplicate submissions never advance the agreement past its correct signature state", async () => {
      const setup = await setupPersonalAwaitingSignatures();
      const sessionId = randomUUID();
      await readySigner(setup.creditorUserId, sessionId, setup.creditorProfileId);
      const signOnce = () =>
        ctx.signatureService.sign({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          actingSessionId: sessionId,
          authMethod: "totp",
          consentVersion: CONSENT,
          timezone: TZ,
          deviceInfo: null,
          ipAddress: "203.0.113.10",
        });

      await signOnce();
      for (let i = 0; i < 3; i += 1) {
        await grantStepUp({ mfaCredentials: ctx.mfaCredentials, stepUps: ctx.stepUps }, setup.creditorUserId, sessionId);
        await expect(signOnce()).rejects.toThrow(ValidationError);
      }

      const agreement = await ctx.agreementCtx.agreements.findById(setup.agreementId);
      expect(agreement?.status).toBe("awaiting_signatures"); // still only one party has signed
      const pdf = await ctx.agreementPdfs.findByVersion(setup.versionId);
      expect(pdf).toBeNull(); // no PDF generated from a single-party signature
    });
  });

  /**
   * PRSprint 12 requirement #20/#34: a signature on one agreement version must never carry forward
   * to a later version produced by an amendment. Exercises the real cross-service integration
   * (SignatureService for the original version, AmendmentService for the amendment) rather than
   * asserting only against raw repository state.
   */
  describe("amendment interaction: signatures do not carry forward across versions", () => {
    it("version 1's signature evidence stays tied to version 1 after an amendment creates version 2, and version 2 starts requiring its own fresh approval", async () => {
      const setup = await signBothParties();
      const originalVersion = await ctx.agreementCtx.versions.findById(setup.versionId);
      expect(originalVersion?.signedAt).not.toBeNull();

      // Shares ctx.agreementCtx's own versions/agreements/scheduleItems repos (not a fresh, separate
      // createTestAmendmentService() context) so the amendment operates on the *same* agreement this
      // test already signed via SignatureService — mirroring how production's AmendmentService and
      // SignatureService both resolve through the same getAgreementService() singleton.
      const amendments = new InMemoryAmendmentRepository();
      const application = new InMemoryAmendmentApplicationRepository({
        versions: ctx.agreementCtx.versions,
        agreements: ctx.agreementCtx.agreements,
        scheduleItems: ctx.agreementCtx.scheduleItems,
        amendments,
      });
      const amendmentService = new AmendmentService({
        agreementService: ctx.agreementCtx.agreementService,
        amendments,
        versions: ctx.agreementCtx.versions,
        application,
        audit: new AuditService(new InMemoryAmendmentAuditRepositoryForThisTest()),
        profileOwners: ctx.agreementCtx.profileOwners,
      });

      const proposed = await amendmentService.proposeAmendment({
        agreementId: setup.agreementId,
        actingUserId: setup.debtorUserId,
        changeType: "reduced_installment",
        reason: "Reduced hours at work",
        proposedTerms: baseTerms({ installmentAmountMinorUnits: 15_000 }),
      });
      await amendmentService.decideAmendment({ amendmentId: proposed.id, actingUserId: setup.creditorUserId, decision: "accept" });
      const afterCreditorSign = await amendmentService.signAmendment({ amendmentId: proposed.id, actingUserId: setup.creditorUserId });
      expect(afterCreditorSign.status).not.toBe("applied"); // only one of two amendment signatures so far
      const applied = await amendmentService.signAmendment({ amendmentId: proposed.id, actingUserId: setup.debtorUserId });
      expect(applied.status).toBe("applied");
      const newVersionId = applied.resultingVersionId!;
      expect(newVersionId).not.toBe(setup.versionId);

      // Version 1's own signature_event rows are untouched — still exactly the two recorded when it
      // was originally signed, still pointing at version 1's id specifically.
      const version1Events = await ctx.signatureEvents.listForVersion(setup.versionId);
      expect(version1Events).toHaveLength(2);
      expect(version1Events.every((e) => e.agreementVersionId === setup.versionId)).toBe(true);

      // No signature_event exists for version 2 through SignatureService's own evidence trail —
      // version 2's "signed" state came from the amendment's own approval, a different, version-2-
      // scoped signing act, never from version 1's signature_event rows being copied or reused.
      const version2Events = await ctx.signatureEvents.listForVersion(newVersionId);
      expect(version2Events).toHaveLength(0);

      // Version 1 remains, unchanged, permanently retrievable — the prior signed record was
      // preserved, not overwritten.
      const stillThere = await ctx.agreementCtx.versions.findById(setup.versionId);
      expect(stillThere?.signedAt).toEqual(originalVersion?.signedAt);
      expect(stillThere?.documentHash).toBe(originalVersion?.documentHash);
    });
  });

  /**
   * PRSprint 13 (docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md): before this, SignatureService
   * never called NotificationService.notify at all, despite `agreement_signed` existing in the
   * taxonomy since Sprint 17 for exactly this purpose. Uses its own local `notifiedCtx` (constructed
   * with a real NotificationService) rather than the outer `beforeEach`'s, which omits it.
   */
  describe("PRSprint 13: notification wiring", () => {
    async function setupNotified() {
      const { createTestNotificationService } = await import("@/lib/notify/testFakes");
      const notifyCtx = createTestNotificationService();
      const notifiedCtx = createTestSignatureService(notifyCtx.notificationService);
      const creditorUserId = randomUUID();
      const debtorUserId = randomUUID();
      const creditorProfileId = await seedPersonalParty(notifiedCtx, creditorUserId);
      const debtorProfileId = await seedPersonalParty(notifiedCtx, debtorUserId);
      const created = await notifiedCtx.agreementCtx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await notifiedCtx.agreementCtx.agreementService.submitDraft(created.agreement.id, creditorUserId);
      await notifiedCtx.agreementCtx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await notifiedCtx.agreementCtx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });
      const creditorSession = randomUUID();
      const debtorSession = randomUUID();
      await grantStepUp({ mfaCredentials: notifiedCtx.mfaCredentials, stepUps: notifiedCtx.stepUps }, creditorUserId, creditorSession);
      await grantStepUp({ mfaCredentials: notifiedCtx.mfaCredentials, stepUps: notifiedCtx.stepUps }, debtorUserId, debtorSession);
      await markFullyVerified(notifiedCtx, "personal", creditorProfileId);
      await markFullyVerified(notifiedCtx, "personal", debtorProfileId);
      return { notifiedCtx, notifyCtx, agreementId: created.agreement.id, creditorUserId, debtorUserId, creditorSession, debtorSession };
    }

    it("when only one party has signed, notifies the OTHER (unsigned) party — never the signer themself", async () => {
      const { notifiedCtx, notifyCtx, agreementId, creditorUserId, debtorUserId, creditorSession } = await setupNotified();
      await notifiedCtx.signatureService.sign({
        agreementId,
        actingUserId: creditorUserId,
        actingSessionId: creditorSession,
        authMethod: "totp",
        consentVersion: "v1",
        timezone: "UTC",
        deviceInfo: null,
        ipAddress: "203.0.113.10",
      });
      const debtorNotifications = await notifyCtx.notificationService.listForUser(debtorUserId);
      expect(debtorNotifications.some((n) => n.notificationType === "agreement_counterparty_signed")).toBe(true);
      const creditorNotifications = await notifyCtx.notificationService.listForUser(creditorUserId);
      expect(creditorNotifications.some((n) => n.notificationType === "agreement_counterparty_signed")).toBe(false);
    });

    it("when both parties have signed, notifies BOTH parties of full execution", async () => {
      const { notifiedCtx, notifyCtx, agreementId, creditorUserId, debtorUserId, creditorSession, debtorSession } = await setupNotified();
      await notifiedCtx.signatureService.sign({
        agreementId,
        actingUserId: creditorUserId,
        actingSessionId: creditorSession,
        authMethod: "totp",
        consentVersion: "v1",
        timezone: "UTC",
        deviceInfo: null,
        ipAddress: "203.0.113.10",
      });
      await notifiedCtx.signatureService.sign({
        agreementId,
        actingUserId: debtorUserId,
        actingSessionId: debtorSession,
        authMethod: "totp",
        consentVersion: "v1",
        timezone: "UTC",
        deviceInfo: null,
        ipAddress: "203.0.113.20",
      });
      const creditorNotifications = await notifyCtx.notificationService.listForUser(creditorUserId);
      const debtorNotifications = await notifyCtx.notificationService.listForUser(debtorUserId);
      expect(creditorNotifications.some((n) => n.notificationType === "agreement_signed")).toBe(true);
      expect(debtorNotifications.some((n) => n.notificationType === "agreement_signed")).toBe(true);
    });

    it("a notification-layer failure never fails the underlying signature (failure isolation)", async () => {
      const { notifiedCtx, agreementId, creditorUserId, creditorSession } = await setupNotified();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (notifiedCtx.signatureService as any).deps.notifications = { notify: async () => { throw new Error("simulated_notify_outage"); } };
      const result = await notifiedCtx.signatureService.sign({
        agreementId,
        actingUserId: creditorUserId,
        actingSessionId: creditorSession,
        authMethod: "totp",
        consentVersion: "v1",
        timezone: "UTC",
        deviceInfo: null,
        ipAddress: "203.0.113.10",
      });
      expect(result.signatureEvent.signerRole).toBe("creditor");
    });
  });
});
