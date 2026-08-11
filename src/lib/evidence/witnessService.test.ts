import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createTestEvidenceWitnessContext, seedVerifiedPersonalUser } from "./testFakes";
import { MAX_WITNESSES_PER_AGREEMENT } from "./witnessService";

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
    hardshipRules: "Borrower may request hardship relief.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

describe("WitnessService", () => {
  let ctx: ReturnType<typeof createTestEvidenceWitnessContext>;

  async function setupAgreement() {
    const creditorUserId = randomUUID();
    const debtorUserId = randomUUID();
    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    ctx.agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    ctx.agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);
    const created = await ctx.agreementCtx.agreementService.createDraft({
      creatorUserId: creditorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    return { agreementId: created.agreement.id, versionId: created.version.id, creditorUserId, debtorUserId };
  }

  beforeEach(() => {
    ctx = createTestEvidenceWitnessContext();
  });

  describe("adding a witness", () => {
    it("allows a party to add a verified witness, and rejects a non-party", async () => {
      const setup = await setupAgreement();
      const witnessUserId = randomUUID();
      await seedVerifiedPersonalUser(ctx, witnessUserId);

      const record = await ctx.witnessService.addWitness({
        agreementId: setup.agreementId,
        actingUserId: setup.creditorUserId,
        witnessUserId,
        ipAddress: "203.0.113.5",
        deviceInfo: null,
      });
      expect(record.witnessUserId).toBe(witnessUserId);
      expect(record.attestedVersionId).toBeNull();

      const stranger = randomUUID();
      const anotherCandidate = randomUUID();
      await seedVerifiedPersonalUser(ctx, anotherCandidate);
      await expect(
        ctx.witnessService.addWitness({
          agreementId: setup.agreementId,
          actingUserId: stranger,
          witnessUserId: anotherCandidate,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects an unverified candidate", async () => {
      const setup = await setupAgreement();
      const unverifiedUserId = randomUUID();
      await ctx.personalProfiles.insert(unverifiedUserId); // no verification record inserted

      await expect(
        ctx.witnessService.addWitness({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          witnessUserId: unverifiedUserId,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a party nominating themselves, and rejects nominating the counterparty", async () => {
      const setup = await setupAgreement();
      await expect(
        ctx.witnessService.addWitness({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          witnessUserId: setup.creditorUserId,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        ctx.witnessService.addWitness({
          agreementId: setup.agreementId,
          actingUserId: setup.creditorUserId,
          witnessUserId: setup.debtorUserId,
          ipAddress: null,
          deviceInfo: null,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("enforces a maximum of two witnesses and rejects duplicates", async () => {
      const setup = await setupAgreement();
      expect(MAX_WITNESSES_PER_AGREEMENT).toBe(2);

      const witness1 = randomUUID();
      const witness2 = randomUUID();
      const witness3 = randomUUID();
      await seedVerifiedPersonalUser(ctx, witness1);
      await seedVerifiedPersonalUser(ctx, witness2);
      await seedVerifiedPersonalUser(ctx, witness3);

      await ctx.witnessService.addWitness({ agreementId: setup.agreementId, actingUserId: setup.creditorUserId, witnessUserId: witness1, ipAddress: null, deviceInfo: null });
      await ctx.witnessService.addWitness({ agreementId: setup.agreementId, actingUserId: setup.creditorUserId, witnessUserId: witness2, ipAddress: null, deviceInfo: null });

      await expect(
        ctx.witnessService.addWitness({ agreementId: setup.agreementId, actingUserId: setup.creditorUserId, witnessUserId: witness3, ipAddress: null, deviceInfo: null }),
      ).rejects.toThrow(ValidationError);

      await expect(
        ctx.witnessService.addWitness({ agreementId: setup.agreementId, actingUserId: setup.debtorUserId, witnessUserId: witness1, ipAddress: null, deviceInfo: null }),
      ).rejects.toThrow(ValidationError); // duplicate
    });
  });

  describe("version linkage (attestation)", () => {
    it("attests to the agreement's exact current version, once only", async () => {
      const setup = await setupAgreement();
      const witnessUserId = randomUUID();
      await seedVerifiedPersonalUser(ctx, witnessUserId);
      await ctx.witnessService.addWitness({ agreementId: setup.agreementId, actingUserId: setup.creditorUserId, witnessUserId, ipAddress: null, deviceInfo: null });

      await ctx.witnessService.attest({ agreementId: setup.agreementId, actingUserId: witnessUserId, ipAddress: "203.0.113.9", deviceInfo: null });
      const row = await ctx.witnessRepo.findByAgreementAndUser(setup.agreementId, witnessUserId);
      expect(row?.attestedVersionId).toBe(setup.versionId);
      expect(row?.attestedAt).not.toBeNull();

      await expect(
        ctx.witnessService.attest({ agreementId: setup.agreementId, actingUserId: witnessUserId, ipAddress: null, deviceInfo: null }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects attestation from a non-witness", async () => {
      const setup = await setupAgreement();
      await expect(
        ctx.witnessService.attest({ agreementId: setup.agreementId, actingUserId: setup.creditorUserId, ipAddress: null, deviceInfo: null }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("witness isolation — structural and behavioral", () => {
    it("a witness has zero standing in AgreementService: every mutating method rejects them", async () => {
      const setup = await setupAgreement();
      const witnessUserId = randomUUID();
      await seedVerifiedPersonalUser(ctx, witnessUserId);
      await ctx.witnessService.addWitness({ agreementId: setup.agreementId, actingUserId: setup.creditorUserId, witnessUserId, ipAddress: null, deviceInfo: null });

      await expect(ctx.agreementCtx.agreementService.getAgreement(setup.agreementId, witnessUserId)).rejects.toThrow(ForbiddenError);
      await expect(ctx.agreementCtx.agreementService.submitDraft(setup.agreementId, witnessUserId)).rejects.toThrow(ForbiddenError);
      await expect(ctx.agreementCtx.agreementService.acknowledgeDebt(setup.agreementId, witnessUserId)).rejects.toThrow(ForbiddenError);
      await expect(
        ctx.agreementCtx.agreementService.creditorDecide({ agreementId: setup.agreementId, actingUserId: witnessUserId, decision: "accept" }),
      ).rejects.toThrow(ForbiddenError);
      await expect(ctx.agreementCtx.agreementService.signAgreement(setup.agreementId, witnessUserId)).rejects.toThrow(ForbiddenError);
    });

    it("WitnessService itself exposes no method capable of amending terms, moving funds, or approving settlement", () => {
      const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.witnessService));
      const dangerous = methodNames.filter((name) => /amend|fund|payout|settle|sign|accept|reject|counter/i.test(name));
      expect(dangerous).toEqual([]);
    });

    it("a non-witness (including an actual party) cannot use the witness-only view", async () => {
      const setup = await setupAgreement();
      await expect(ctx.witnessService.getWitnessView(setup.agreementId, setup.creditorUserId)).rejects.toThrow(
        ForbiddenError,
      );
      const stranger = randomUUID();
      await expect(ctx.witnessService.getWitnessView(setup.agreementId, stranger)).rejects.toThrow(ForbiddenError);
    });

    it("an active witness can view the agreement via the witness-only path", async () => {
      const setup = await setupAgreement();
      const witnessUserId = randomUUID();
      await seedVerifiedPersonalUser(ctx, witnessUserId);
      await ctx.witnessService.addWitness({ agreementId: setup.agreementId, actingUserId: setup.creditorUserId, witnessUserId, ipAddress: null, deviceInfo: null });

      const view = await ctx.witnessService.getWitnessView(setup.agreementId, witnessUserId);
      expect(view.agreement.id).toBe(setup.agreementId);
      expect(view.version.id).toBe(setup.versionId);
    });
  });

  describe("listing witnesses", () => {
    it("allows a party or a witness to list the roster, and rejects a stranger", async () => {
      const setup = await setupAgreement();
      const witnessUserId = randomUUID();
      await seedVerifiedPersonalUser(ctx, witnessUserId);
      await ctx.witnessService.addWitness({ agreementId: setup.agreementId, actingUserId: setup.creditorUserId, witnessUserId, ipAddress: null, deviceInfo: null });

      const asParty = await ctx.witnessService.listWitnesses(setup.agreementId, setup.debtorUserId);
      expect(asParty).toHaveLength(1);
      const asWitness = await ctx.witnessService.listWitnesses(setup.agreementId, witnessUserId);
      expect(asWitness).toHaveLength(1);

      const stranger = randomUUID();
      await expect(ctx.witnessService.listWitnesses(setup.agreementId, stranger)).rejects.toThrow(ForbiddenError);
    });
  });
});
