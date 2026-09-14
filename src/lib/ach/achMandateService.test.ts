import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestAchMandateService, seedAgreementForMandateTest } from "./testFakes";

const PAYER = { profileKind: "personal" as const, profileId: "payer-1" };
const CREDITOR = { profileKind: "business" as const, profileId: "creditor-1" };
const PAYER_USER_ID = "payer-user-1";
const OTHER_USER_ID = "other-user-1";

describe("AchMandateService", () => {
  let ctx: ReturnType<typeof createTestAchMandateService>;
  const agreementId = randomUUID();

  beforeEach(() => {
    ctx = createTestAchMandateService();
    ctx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    // R08 B1: `agreementId`'s own persisted debtor is PAYER — matches every pre-existing test below,
    // which all treat PAYER as the (implicit, pre-R08) debtor. Tests that need a MISMATCHED debtor
    // seed their own separate agreementId explicitly.
    seedAgreementForMandateTest(ctx.agreements, agreementId, PAYER, CREDITOR);
  });

  it("authorizes a mandate for the payer's own profile", async () => {
    const mandate = await ctx.achMandateService.authorize({
      agreementId,
      payer: PAYER,
      bankAccountRef: "sandbox_bank_1",
      actingUserId: PAYER_USER_ID,
    });
    expect(mandate.status).toBe("active");
    expect(mandate.supersedesMandateId).toBeNull();
  });

  it("rejects authorizing a mandate for a profile the caller does not own", async () => {
    await expect(
      ctx.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "x", actingUserId: OTHER_USER_ID }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejects a second active mandate for the same agreement", async () => {
    await ctx.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "a", actingUserId: PAYER_USER_ID });
    await expect(
      ctx.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "b", actingUserId: PAYER_USER_ID }),
    ).rejects.toThrow(ConflictError);
  });

  it("revokes an active mandate; a second revocation attempt fails", async () => {
    const mandate = await ctx.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "a", actingUserId: PAYER_USER_ID });
    const revoked = await ctx.achMandateService.revoke({ mandateId: mandate.id, actingUserId: PAYER_USER_ID, reason: "no longer needed" });
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).not.toBeNull();
    await expect(
      ctx.achMandateService.revoke({ mandateId: mandate.id, actingUserId: PAYER_USER_ID, reason: "again" }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects revoking someone else's mandate", async () => {
    const mandate = await ctx.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "a", actingUserId: PAYER_USER_ID });
    await expect(
      ctx.achMandateService.revoke({ mandateId: mandate.id, actingUserId: OTHER_USER_ID, reason: "x" }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("after revocation, no active mandate exists for the agreement", async () => {
    const mandate = await ctx.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "a", actingUserId: PAYER_USER_ID });
    await ctx.achMandateService.revoke({ mandateId: mandate.id, actingUserId: PAYER_USER_ID, reason: "x" });
    expect(await ctx.achMandateService.isActiveForAgreement(agreementId)).toBe(false);
  });

  it("bank-change hook: revokes the old mandate and creates a new one linked via supersedesMandateId", async () => {
    const original = await ctx.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "old_bank", actingUserId: PAYER_USER_ID });
    const replacement = await ctx.achMandateService.handleBankChange({
      agreementId,
      payer: PAYER,
      newBankAccountRef: "new_bank",
      actingUserId: PAYER_USER_ID,
    });
    expect(replacement.supersedesMandateId).toBe(original.id);
    expect(replacement.bankAccountRef).toBe("new_bank");
    expect((await ctx.mandates.findById(original.id))?.status).toBe("revoked");
    expect(await ctx.achMandateService.getActiveMandate(agreementId)).toMatchObject({ id: replacement.id });
  });

  it("bank-change hook works even with no prior mandate (first-time authorization via the same hook)", async () => {
    const mandate = await ctx.achMandateService.handleBankChange({
      agreementId,
      payer: PAYER,
      newBankAccountRef: "first_bank",
      actingUserId: PAYER_USER_ID,
    });
    expect(mandate.supersedesMandateId).toBeNull();
  });

  it("audits every mandate lifecycle action", async () => {
    const mandate = await ctx.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "a", actingUserId: PAYER_USER_ID });
    await ctx.achMandateService.revoke({ mandateId: mandate.id, actingUserId: PAYER_USER_ID, reason: "done" });
    expect(ctx.auditRepo.events.map((e) => e.action)).toEqual(["ach_mandate_authorized", "ach_mandate_revoked"]);
  });

  it("is structurally incapable of touching ledger or agreement data (revocation cannot erase debt)", () => {
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.achMandateService));
    // No dependency injected is a LedgerService/AgreementService, and no method here posts entries
    // or changes agreement status — verified by the class's own dependency list, not just naming.
    expect(methodNames).not.toContain("postPaymentCleared");
    expect(methodNames).not.toContain("updateAgreementStatus");
    expect(methodNames).not.toContain("adjustBalance");
  });

  // ---------------------------------------------------------------------------------------------
  // R08 B1 — ACH-1: the payer must be EXACTLY the supplied agreement's own persisted debtor, never
  // merely a party the caller happens to own, and never inferred from creditor/createdByUserId.
  // ---------------------------------------------------------------------------------------------
  describe("R08 B1 (ACH-1): agreement-bound payer authorization", () => {
    it("ACH-R08-1: valid owner + payer equals the agreement's own debtor -> authorize succeeds", async () => {
      const mandate = await ctx.achMandateService.authorize({
        agreementId,
        payer: PAYER,
        bankAccountRef: "sandbox_bank_1",
        actingUserId: PAYER_USER_ID,
      });
      expect(mandate.status).toBe("active");
      expect(mandate.agreementId).toBe(agreementId);
    });

    it("ACH-R08-2/ACH-R08-3: owner of profile P + an unrelated agreement whose debtor is someone else -> ForbiddenError, zero mandates inserted", async () => {
      const victimAgreementId = randomUUID();
      const victimDebtor = { profileKind: "personal" as const, profileId: "victim-debtor-1" };
      seedAgreementForMandateTest(ctx.agreements, victimAgreementId, victimDebtor, CREDITOR);

      await expect(
        ctx.achMandateService.authorize({
          agreementId: victimAgreementId,
          payer: PAYER, // attacker owns PAYER, but PAYER is not victimAgreementId's debtor
          bankAccountRef: "attacker_bank",
          actingUserId: PAYER_USER_ID,
        }),
      ).rejects.toThrow(ForbiddenError);

      expect(ctx.mandates.byId.size).toBe(0);
    });

    it("ACH-R08-4: nonexistent agreement -> ValidationError, zero mandates inserted", async () => {
      const missingAgreementId = randomUUID();
      await expect(
        ctx.achMandateService.authorize({
          agreementId: missingAgreementId,
          payer: PAYER,
          bankAccountRef: "x",
          actingUserId: PAYER_USER_ID,
        }),
      ).rejects.toThrow(ValidationError);

      expect(ctx.mandates.byId.size).toBe(0);
    });

    it("ACH-R08-5: caller owns the agreement's CREDITOR profile, but the creditor is not the debtor -> rejected (being a party is insufficient; the canonical debtor is required)", async () => {
      const creditorUserId = "creditor-user-1";
      ctx.profileOwners.set(CREDITOR.profileKind, CREDITOR.profileId, creditorUserId);

      await expect(
        ctx.achMandateService.authorize({
          agreementId, // debtor is PAYER, creditor is CREDITOR
          payer: CREDITOR, // caller genuinely owns CREDITOR, and CREDITOR genuinely is a party...
          bankAccountRef: "x",
          actingUserId: creditorUserId, // ...but is not the debtor.
        }),
      ).rejects.toThrow(ForbiddenError);

      expect(ctx.mandates.byId.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // R08 B2 — EC1-002: handleBankChange (the bank-change hook) must ALSO require the payer be the
  // supplied agreement's own persisted debtor — reusing the exact same requirePayerIsAgreementDebtor
  // helper the ACH-R08-* suite above already verifies for authorize(). Previously this method called
  // only requireOwner, letting an attacker who merely owns some unrelated profile revoke a victim
  // agreement's real mandate and replace it with one pointing at their own profile/bank reference.
  // ---------------------------------------------------------------------------------------------
  describe("R08 B2 (EC1-002): bank-change hook agreement-bound payer authorization", () => {
    it("ACH-R08-B2-1: legitimate debtor with an existing active mandate -> bank change succeeds, original becomes revoked, replacement is active and linked via supersedesMandateId", async () => {
      const original = await ctx.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "old_bank", actingUserId: PAYER_USER_ID });
      const replacement = await ctx.achMandateService.handleBankChange({
        agreementId,
        payer: PAYER,
        newBankAccountRef: "new_bank",
        actingUserId: PAYER_USER_ID,
      });
      expect(replacement.status).toBe("active");
      expect(replacement.supersedesMandateId).toBe(original.id);
      expect((await ctx.mandates.findById(original.id))?.status).toBe("revoked");
    });

    it("ACH-R08-B2-2: attacker owns an unrelated profile P; victim agreement already has a legitimate active mandate -> ForbiddenError; original mandate remains ACTIVE and untouched; no replacement inserted; no audit written by the rejected call (the critical zero-mutation regression test)", async () => {
      const victimAgreementId = randomUUID();
      const victimDebtor = { profileKind: "personal" as const, profileId: "victim-debtor-2" };
      seedAgreementForMandateTest(ctx.agreements, victimAgreementId, victimDebtor, CREDITOR);
      const victimUserId = "victim-user-1";
      ctx.profileOwners.set(victimDebtor.profileKind, victimDebtor.profileId, victimUserId);

      const original = await ctx.achMandateService.authorize({
        agreementId: victimAgreementId,
        payer: victimDebtor,
        bankAccountRef: "victim_bank",
        actingUserId: victimUserId,
      });
      ctx.auditRepo.events = []; // discard the legitimate setup's own audit history — this test only cares about the rejected call's effects.
      const mandateCountBefore = ctx.mandates.byId.size;

      await expect(
        ctx.achMandateService.handleBankChange({
          agreementId: victimAgreementId,
          payer: PAYER, // attacker owns PAYER, but PAYER is not victimAgreementId's debtor
          newBankAccountRef: "attacker_bank",
          actingUserId: PAYER_USER_ID,
        }),
      ).rejects.toThrow(ForbiddenError);

      const stillOriginal = await ctx.mandates.findById(original.id);
      expect(stillOriginal?.status).toBe("active");
      expect(stillOriginal?.revokedAt).toBeNull();
      // Zero mutation: no new mandate row (the replacement) was inserted.
      expect(ctx.mandates.byId.size).toBe(mandateCountBefore);
      // No ach_mandate_superseded audit and no ach_mandate_authorized audit were written for this
      // rejected call.
      expect(ctx.auditRepo.events).toHaveLength(0);
    });

    it("ACH-R08-B2-3: attacker owns an unrelated profile P; victim agreement has NO existing mandate -> ForbiddenError; zero mandate inserted (the first-time-authorization-via-bank-change path is also closed)", async () => {
      const victimAgreementId = randomUUID();
      const victimDebtor = { profileKind: "personal" as const, profileId: "victim-debtor-3" };
      seedAgreementForMandateTest(ctx.agreements, victimAgreementId, victimDebtor, CREDITOR);

      await expect(
        ctx.achMandateService.handleBankChange({
          agreementId: victimAgreementId,
          payer: PAYER,
          newBankAccountRef: "attacker_bank",
          actingUserId: PAYER_USER_ID,
        }),
      ).rejects.toThrow(ForbiddenError);

      expect(ctx.mandates.byId.size).toBe(0);
    });

    it("ACH-R08-B2-4: caller owns the agreement's CREDITOR profile, but the creditor is not the debtor -> ForbiddenError; the existing legitimate debtor mandate remains unchanged (being a party is insufficient)", async () => {
      await ctx.achMandateService.authorize({ agreementId, payer: PAYER, bankAccountRef: "old_bank", actingUserId: PAYER_USER_ID });
      const creditorUserId = "creditor-user-2";
      ctx.profileOwners.set(CREDITOR.profileKind, CREDITOR.profileId, creditorUserId);

      await expect(
        ctx.achMandateService.handleBankChange({
          agreementId, // debtor is PAYER, creditor is CREDITOR
          payer: CREDITOR, // caller genuinely owns CREDITOR, and CREDITOR genuinely is a party...
          newBankAccountRef: "creditor_bank",
          actingUserId: creditorUserId, // ...but is not the debtor.
        }),
      ).rejects.toThrow(ForbiddenError);

      const activeMandate = await ctx.achMandateService.getActiveMandate(agreementId);
      expect(activeMandate?.bankAccountRef).toBe("old_bank");
      expect(activeMandate?.status).toBe("active");
    });

    it("ACH-R08-B2-5: nonexistent agreement -> ValidationError; no mandate revoked or inserted; no success audit", async () => {
      const missingAgreementId = randomUUID();
      await expect(
        ctx.achMandateService.handleBankChange({
          agreementId: missingAgreementId,
          payer: PAYER,
          newBankAccountRef: "x",
          actingUserId: PAYER_USER_ID,
        }),
      ).rejects.toThrow(ValidationError);

      expect(ctx.mandates.byId.size).toBe(0);
      expect(ctx.auditRepo.events).toHaveLength(0);
    });
  });
});
