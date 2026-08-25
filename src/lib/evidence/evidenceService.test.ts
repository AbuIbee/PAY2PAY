import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createTestEvidenceWitnessContext, seedVerifiedPersonalUser } from "./testFakes";
import { MAX_EVIDENCE_FILE_SIZE_BYTES } from "./fileValidator";

function baseTerms(overrides: Partial<DraftTermsInput> = {}): DraftTermsInput {
  return {
    category: "personal_loan",
    description: "Loan for car repair",
    originalAmountMinorUnits: 120_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 20_000,
    installmentAmountMinorUnits: 20_000,
    frequency: "monthly",
    firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    feeAllocation: "debtor_pays",
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Borrower may request hardship relief.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]); // "MZ" (Windows executable header)

describe("EvidenceService", () => {
  let ctx: ReturnType<typeof createTestEvidenceWitnessContext>;

  async function setupAgreement() {
    const creditorUserId = randomUUID();
    const debtorUserId = randomUUID();
    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    ctx.agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    ctx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);
    // Agreement Lifecycle V2: debtor originates so the creditor is the counterparty and may sign
    // first in signBothParties below.
    const created = await ctx.agreementCtx.agreementService.createDraft({
      creatorUserId: debtorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    return { agreementId: created.agreement.id, creditorUserId, debtorUserId, creditorProfileId, debtorProfileId };
  }

  async function signBothParties(setup: Awaited<ReturnType<typeof setupAgreement>>) {
    await ctx.agreementCtx.agreementService.submitDraft(setup.agreementId, setup.creditorUserId);
    await ctx.agreementCtx.agreementService.acknowledgeDebt(setup.agreementId, setup.debtorUserId);
    await ctx.agreementCtx.agreementService.creditorDecide({
      agreementId: setup.agreementId,
      actingUserId: setup.creditorUserId,
      decision: "accept",
    });
    await ctx.agreementCtx.agreementService.signAgreement(setup.agreementId, setup.creditorUserId);
    await ctx.agreementCtx.agreementService.signAgreement(setup.agreementId, setup.debtorUserId);
  }

  beforeEach(() => {
    ctx = createTestEvidenceWitnessContext();
  });

  describe("access control", () => {
    it("allows a party to upload and list evidence, and rejects a stranger", async () => {
      const setup = await setupAgreement();
      const record = await ctx.evidenceService.uploadEvidence({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        documentType: "invoice",
        description: "Original invoice",
        fileName: "invoice.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
        visibility: "shared",
        sharedWithWitnesses: false,
        ipAddress: "203.0.113.1",
        deviceInfo: null,
      });
      expect(record.documentType).toBe("invoice");

      const list = await ctx.evidenceService.listEvidence(setup.agreementId, setup.debtorUserId);
      expect(list).toHaveLength(1);

      const stranger = randomUUID();
      await expect(ctx.evidenceService.listEvidence(setup.agreementId, stranger)).rejects.toThrow(ForbiddenError);
      await expect(
        ctx.evidenceService.uploadEvidence({
          agreementId: setup.agreementId,
          actingUserId: stranger,
          documentType: "invoice",
          description: null,
          fileName: "invoice.pdf",
          contentType: "application/pdf",
          content: PDF_BYTES,
          visibility: "shared",
          sharedWithWitnesses: false,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("hides 'private' evidence from the counterparty but shows it to the uploader", async () => {
      const setup = await setupAgreement();
      await ctx.evidenceService.uploadEvidence({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        documentType: "other",
        description: "Private note",
        fileName: "note.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
        visibility: "private",
        sharedWithWitnesses: false,
        ipAddress: null,
        deviceInfo: null,
      });

      const creditorView = await ctx.evidenceService.listEvidence(setup.agreementId, setup.creditorUserId);
      expect(creditorView).toHaveLength(1);
      const debtorView = await ctx.evidenceService.listEvidence(setup.agreementId, setup.debtorUserId);
      expect(debtorView).toHaveLength(0);
    });
  });

  describe("post-signing labeling", () => {
    it("labels evidence uploaded before signing as not post-signing, and after as post-signing", async () => {
      const setup = await setupAgreement();
      const before = await ctx.evidenceService.uploadEvidence({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        documentType: "estimate",
        description: null,
        fileName: "estimate.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
        visibility: "shared",
        sharedWithWitnesses: false,
        ipAddress: null,
        deviceInfo: null,
      });
      expect(before.isPostSigning).toBe(false);

      await signBothParties(setup);

      const after = await ctx.evidenceService.uploadEvidence({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        documentType: "proof_of_completed_work",
        description: null,
        fileName: "proof.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
        visibility: "shared",
        sharedWithWitnesses: false,
        ipAddress: null,
        deviceInfo: null,
      });
      expect(after.isPostSigning).toBe(true);

      // The pre-signing item must never retroactively flip.
      const list = await ctx.evidenceService.listEvidence(setup.agreementId, setup.creditorUserId);
      const beforeRefreshed = list.find((item) => item.id === before.id);
      expect(beforeRefreshed?.isPostSigning).toBe(false);
    });
  });

  describe("witness isolation", () => {
    it("a witness sees only shared+witness-shared evidence, never private or shared-but-not-witness-shared", async () => {
      const setup = await setupAgreement();
      const witnessUserId = randomUUID();
      await seedVerifiedPersonalUser(ctx, witnessUserId);
      await ctx.witnessService.addWitness({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        witnessUserId,
        ipAddress: null,
        deviceInfo: null,
      });

      await ctx.evidenceService.uploadEvidence({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        documentType: "invoice",
        description: "witness-visible",
        fileName: "a.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
        visibility: "shared",
        sharedWithWitnesses: true,
        ipAddress: null,
        deviceInfo: null,
      });
      await ctx.evidenceService.uploadEvidence({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        documentType: "invoice",
        description: "shared but not witness-shared",
        fileName: "b.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
        visibility: "shared",
        sharedWithWitnesses: false,
        ipAddress: null,
        deviceInfo: null,
      });
      await ctx.evidenceService.uploadEvidence({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        documentType: "invoice",
        description: "private",
        fileName: "c.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
        visibility: "private",
        sharedWithWitnesses: true, // even if flagged, private always wins
        ipAddress: null,
        deviceInfo: null,
      });

      const witnessView = await ctx.evidenceService.listEvidence(setup.agreementId, witnessUserId);
      expect(witnessView).toHaveLength(1);
      expect(witnessView[0]?.description).toBe("witness-visible");
    });

    it("a witness cannot upload evidence (has no party standing)", async () => {
      const setup = await setupAgreement();
      const witnessUserId = randomUUID();
      await seedVerifiedPersonalUser(ctx, witnessUserId);
      await ctx.witnessService.addWitness({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        witnessUserId,
        ipAddress: null,
        deviceInfo: null,
      });

      await expect(
        ctx.evidenceService.uploadEvidence({
          agreementId: setup.agreementId,
          actingUserId: witnessUserId,
          documentType: "invoice",
          description: null,
          fileName: "a.pdf",
          contentType: "application/pdf",
          content: PDF_BYTES,
          visibility: "shared",
          sharedWithWitnesses: true,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("document ownership", () => {
    it("only the uploader may withdraw their own evidence", async () => {
      const setup = await setupAgreement();
      const record = await ctx.evidenceService.uploadEvidence({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        documentType: "invoice",
        description: null,
        fileName: "invoice.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
        visibility: "shared",
        sharedWithWitnesses: false,
        ipAddress: null,
        deviceInfo: null,
      });

      await expect(
        ctx.evidenceService.withdrawEvidence(record.id, setup.debtorUserId, null, null),
      ).rejects.toThrow(ForbiddenError);

      await ctx.evidenceService.withdrawEvidence(record.id, setup.creditorUserId, null, null);
      const updated = await ctx.evidenceRepo.findById(record.id);
      expect(updated?.withdrawalState).toBe("withdrawn");

      await expect(
        ctx.evidenceService.withdrawEvidence(record.id, setup.creditorUserId, null, null),
      ).rejects.toThrow(ValidationError); // already withdrawn
    });
  });

  describe("file type restrictions", () => {
    it("rejects an unsupported file extension", async () => {
      const setup = await setupAgreement();
      await expect(
        ctx.evidenceService.uploadEvidence({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          documentType: "other",
          description: null,
          fileName: "script.sh",
          contentType: "text/x-shellscript",
          content: new Uint8Array([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e]),
          visibility: "shared",
          sharedWithWitnesses: false,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a content-type/extension mismatch", async () => {
      const setup = await setupAgreement();
      await expect(
        ctx.evidenceService.uploadEvidence({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          documentType: "invoice",
          description: null,
          fileName: "invoice.pdf",
          contentType: "image/png", // declared PNG but named .pdf
          content: PDF_BYTES,
          visibility: "shared",
          sharedWithWitnesses: false,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("oversized/malicious file handling", () => {
    it("rejects a file over the size limit", async () => {
      const setup = await setupAgreement();
      const oversized = new Uint8Array(MAX_EVIDENCE_FILE_SIZE_BYTES + 1);
      oversized.set(PDF_BYTES);
      await expect(
        ctx.evidenceService.uploadEvidence({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          documentType: "invoice",
          description: null,
          fileName: "big.pdf",
          contentType: "application/pdf",
          content: oversized,
          visibility: "shared",
          sharedWithWitnesses: false,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a file whose content is a disguised executable", async () => {
      const setup = await setupAgreement();
      await expect(
        ctx.evidenceService.uploadEvidence({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          documentType: "invoice",
          description: null,
          fileName: "invoice.pdf",
          contentType: "application/pdf",
          content: EXE_BYTES,
          visibility: "shared",
          sharedWithWitnesses: false,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ValidationError);

      expect(await ctx.evidenceRepo.listForAgreement(setup.agreementId)).toHaveLength(0); // never stored
    });
  });

  describe("dispute flag and signed URL access", () => {
    it("allows a party to flag/unflag, and rejects a non-party", async () => {
      const setup = await setupAgreement();
      const record = await ctx.evidenceService.uploadEvidence({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        documentType: "invoice",
        description: null,
        fileName: "invoice.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
        visibility: "shared",
        sharedWithWitnesses: false,
        ipAddress: null,
        deviceInfo: null,
      });

      await ctx.evidenceService.setDisputeFlag(record.id, setup.debtorUserId, true, null, null);
      expect((await ctx.evidenceRepo.findById(record.id))?.disputeFlag).toBe(true);

      const stranger = randomUUID();
      await expect(ctx.evidenceService.setDisputeFlag(record.id, stranger, false, null, null)).rejects.toThrow(
        ForbiddenError,
      );
    });

    it("issues a signed URL to an authorized party and rejects a stranger", async () => {
      const setup = await setupAgreement();
      const record = await ctx.evidenceService.uploadEvidence({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        documentType: "invoice",
        description: null,
        fileName: "invoice.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
        visibility: "shared",
        sharedWithWitnesses: false,
        ipAddress: null,
        deviceInfo: null,
      });

      const url = await ctx.evidenceService.getSignedEvidenceUrl(record.id, setup.debtorUserId);
      expect(url).toContain("signed");

      const stranger = randomUUID();
      await expect(ctx.evidenceService.getSignedEvidenceUrl(record.id, stranger)).rejects.toThrow(ForbiddenError);
    });
  });
});
