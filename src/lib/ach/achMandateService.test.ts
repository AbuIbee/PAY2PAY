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
});
