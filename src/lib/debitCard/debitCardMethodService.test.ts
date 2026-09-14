import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestDebitCardMethodService, seedAgreementForCardTest, TEST_FUTURE_CARD_EXPIRY, TEST_PAST_CARD_EXPIRY } from "./testFakes";

const PAYER = { profileKind: "personal" as const, profileId: "payer-1" };
const CREDITOR = { profileKind: "business" as const, profileId: "creditor-1" };
const PAYER_USER_ID = "payer-user-1";
const OTHER_USER_ID = "other-user-1";

describe("DebitCardMethodService", () => {
  let ctx: ReturnType<typeof createTestDebitCardMethodService>;
  const agreementId = randomUUID();

  beforeEach(() => {
    ctx = createTestDebitCardMethodService();
    ctx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
    // R08 B1: `agreementId`'s own persisted debtor is PAYER — matches every pre-existing test below,
    // which all treat PAYER as the (implicit, pre-R08) debtor. Tests that need a MISMATCHED debtor
    // seed their own separate agreementId explicitly.
    seedAgreementForCardTest(ctx.agreements, agreementId, PAYER, CREDITOR);
  });

  it("registers a card for the payer's own profile", async () => {
    const card = await ctx.debitCardMethodService.registerCard({
      agreementId,
      payer: PAYER,
      cardToken: "sandbox_pm_1",
      cardLast4: "4242",
      cardBrand: "visa",
      ...TEST_FUTURE_CARD_EXPIRY,
      actingUserId: PAYER_USER_ID,
    });
    expect(card.status).toBe("active");
    expect(card.supersedesCardMethodId).toBeNull();
    expect(card.cardLast4).toBe("4242");
  });

  it("rejects registering a card for a profile the caller does not own", async () => {
    await expect(
      ctx.debitCardMethodService.registerCard({
        agreementId,
        payer: PAYER,
        cardToken: "x",
        cardLast4: "4242",
        cardBrand: null,
        ...TEST_FUTURE_CARD_EXPIRY,
        actingUserId: OTHER_USER_ID,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejects registering an already-expired card", async () => {
    await expect(
      ctx.debitCardMethodService.registerCard({
        agreementId,
        payer: PAYER,
        cardToken: "x",
        cardLast4: "4242",
        cardBrand: null,
        ...TEST_PAST_CARD_EXPIRY,
        actingUserId: PAYER_USER_ID,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a second active card for the same agreement (use replaceCard instead)", async () => {
    await ctx.debitCardMethodService.registerCard({
      agreementId,
      payer: PAYER,
      cardToken: "a",
      cardLast4: "4242",
      cardBrand: null,
      ...TEST_FUTURE_CARD_EXPIRY,
      actingUserId: PAYER_USER_ID,
    });
    await expect(
      ctx.debitCardMethodService.registerCard({
        agreementId,
        payer: PAYER,
        cardToken: "b",
        cardLast4: "1111",
        cardBrand: null,
        ...TEST_FUTURE_CARD_EXPIRY,
        actingUserId: PAYER_USER_ID,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("replaced card: replaceCard supersedes the old card and links back via supersedesCardMethodId", async () => {
    const original = await ctx.debitCardMethodService.registerCard({
      agreementId,
      payer: PAYER,
      cardToken: "old_token",
      cardLast4: "4242",
      cardBrand: "visa",
      ...TEST_FUTURE_CARD_EXPIRY,
      actingUserId: PAYER_USER_ID,
    });
    const replacement = await ctx.debitCardMethodService.replaceCard({
      agreementId,
      payer: PAYER,
      newCardToken: "new_token",
      cardLast4: "1111",
      cardBrand: "mastercard",
      ...TEST_FUTURE_CARD_EXPIRY,
      reason: "old card expiring soon",
      actingUserId: PAYER_USER_ID,
    });
    expect(replacement.supersedesCardMethodId).toBe(original.id);
    expect(replacement.cardLast4).toBe("1111");
    expect((await ctx.cards.findById(original.id))?.status).toBe("replaced");
    expect(await ctx.debitCardMethodService.getActiveCard(agreementId)).toMatchObject({ id: replacement.id });
  });

  it("replaceCard fails when there is no active card to replace", async () => {
    await expect(
      ctx.debitCardMethodService.replaceCard({
        agreementId,
        payer: PAYER,
        newCardToken: "x",
        cardLast4: "4242",
        cardBrand: null,
        ...TEST_FUTURE_CARD_EXPIRY,
        reason: "x",
        actingUserId: PAYER_USER_ID,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects replacing someone else's card", async () => {
    await ctx.debitCardMethodService.registerCard({
      agreementId,
      payer: PAYER,
      cardToken: "a",
      cardLast4: "4242",
      cardBrand: null,
      ...TEST_FUTURE_CARD_EXPIRY,
      actingUserId: PAYER_USER_ID,
    });
    await expect(
      ctx.debitCardMethodService.replaceCard({
        agreementId,
        payer: PAYER,
        newCardToken: "b",
        cardLast4: "1111",
        cardBrand: null,
        ...TEST_FUTURE_CARD_EXPIRY,
        reason: "x",
        actingUserId: OTHER_USER_ID,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("expired: isCardExpired is true once the current date is past the card's expiry month/year", () => {
    // Pure date-boundary check, evaluated against an arbitrary "now" — deliberately not going
    // through registerCard (which now itself rejects an expiry already in the past relative to the
    // real current date), since this test's whole point is checking the boundary at dates other
    // than today.
    const card = { expiresAtMonth: 6, expiresAtYear: 2024 };
    expect(ctx.debitCardMethodService.isCardExpired(card, new Date(Date.UTC(2024, 4, 15)))).toBe(false); // May 2024, valid
    expect(ctx.debitCardMethodService.isCardExpired(card, new Date(Date.UTC(2024, 5, 30)))).toBe(false); // June 2024, valid through end of month
    expect(ctx.debitCardMethodService.isCardExpired(card, new Date(Date.UTC(2024, 6, 1)))).toBe(true); // July 2024, expired
  });

  it("audits every card lifecycle action", async () => {
    const card = await ctx.debitCardMethodService.registerCard({
      agreementId,
      payer: PAYER,
      cardToken: "a",
      cardLast4: "4242",
      cardBrand: null,
      ...TEST_FUTURE_CARD_EXPIRY,
      actingUserId: PAYER_USER_ID,
    });
    await ctx.debitCardMethodService.replaceCard({
      agreementId,
      payer: PAYER,
      newCardToken: "b",
      cardLast4: "1111",
      cardBrand: null,
      ...TEST_FUTURE_CARD_EXPIRY,
      reason: "done",
      actingUserId: PAYER_USER_ID,
    });
    expect(ctx.auditRepo.events.map((e) => e.action)).toEqual([
      "debit_card_method_registered",
      "debit_card_method_superseded",
      "debit_card_method_registered",
    ]);
    void card;
  });

  it("is structurally incapable of touching ledger or agreement data (replacement cannot erase debt)", () => {
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.debitCardMethodService));
    expect(methodNames).not.toContain("postPaymentCleared");
    expect(methodNames).not.toContain("updateAgreementStatus");
    expect(methodNames).not.toContain("adjustBalance");
  });

  // ---------------------------------------------------------------------------------------------
  // R08 B1 — CARD-1: the payer must be EXACTLY the supplied agreement's own persisted debtor, never
  // merely a party the caller happens to own, and never inferred from creditor/createdByUserId.
  // ---------------------------------------------------------------------------------------------
  describe("R08 B1 (CARD-1): agreement-bound payer authorization", () => {
    it("CARD-R08-1: valid owner + payer equals the agreement's own debtor -> registerCard succeeds", async () => {
      const card = await ctx.debitCardMethodService.registerCard({
        agreementId,
        payer: PAYER,
        cardToken: "sandbox_pm_1",
        cardLast4: "4242",
        cardBrand: "visa",
        ...TEST_FUTURE_CARD_EXPIRY,
        actingUserId: PAYER_USER_ID,
      });
      expect(card.status).toBe("active");
      expect(card.agreementId).toBe(agreementId);
    });

    it("CARD-R08-2/CARD-R08-3: owner of profile P + an unrelated agreement -> registerCard throws ForbiddenError, zero cards inserted", async () => {
      const victimAgreementId = randomUUID();
      const victimDebtor = { profileKind: "personal" as const, profileId: "victim-debtor-1" };
      seedAgreementForCardTest(ctx.agreements, victimAgreementId, victimDebtor, CREDITOR);

      await expect(
        ctx.debitCardMethodService.registerCard({
          agreementId: victimAgreementId,
          payer: PAYER, // attacker owns PAYER, but PAYER is not victimAgreementId's debtor
          cardToken: "attacker_token",
          cardLast4: "0000",
          cardBrand: null,
          ...TEST_FUTURE_CARD_EXPIRY,
          actingUserId: PAYER_USER_ID,
        }),
      ).rejects.toThrow(ForbiddenError);

      expect(ctx.cards.byId.size).toBe(0);
    });

    it("CARD-R08-4: nonexistent agreement -> registerCard throws ValidationError, zero cards inserted", async () => {
      const missingAgreementId = randomUUID();
      await expect(
        ctx.debitCardMethodService.registerCard({
          agreementId: missingAgreementId,
          payer: PAYER,
          cardToken: "x",
          cardLast4: "4242",
          cardBrand: null,
          ...TEST_FUTURE_CARD_EXPIRY,
          actingUserId: PAYER_USER_ID,
        }),
      ).rejects.toThrow(ValidationError);

      expect(ctx.cards.byId.size).toBe(0);
    });

    it("CARD-R08-5: valid debtor owner + correct agreement -> replaceCard succeeds when an active card exists", async () => {
      await ctx.debitCardMethodService.registerCard({
        agreementId,
        payer: PAYER,
        cardToken: "old_token",
        cardLast4: "4242",
        cardBrand: "visa",
        ...TEST_FUTURE_CARD_EXPIRY,
        actingUserId: PAYER_USER_ID,
      });

      const replacement = await ctx.debitCardMethodService.replaceCard({
        agreementId,
        payer: PAYER,
        newCardToken: "new_token",
        cardLast4: "1111",
        cardBrand: "mastercard",
        ...TEST_FUTURE_CARD_EXPIRY,
        reason: "lost card",
        actingUserId: PAYER_USER_ID,
      });
      expect(replacement.status).toBe("active");
      expect(replacement.agreementId).toBe(agreementId);
    });

    it("CARD-R08-6/CARD-R08-7: owner of an unrelated profile P + a victim agreement with an existing card -> replaceCard throws ForbiddenError; zero markReplaced, zero insert, no success audit", async () => {
      const victimAgreementId = randomUUID();
      const victimDebtor = { profileKind: "personal" as const, profileId: "victim-debtor-2" };
      seedAgreementForCardTest(ctx.agreements, victimAgreementId, victimDebtor, CREDITOR);
      ctx.profileOwners.set(victimDebtor.profileKind, victimDebtor.profileId, "victim-user-1");

      const originalCard = await ctx.cards.insert({
        agreementId: victimAgreementId,
        payerProfileKind: victimDebtor.profileKind,
        payerProfileId: victimDebtor.profileId,
        cardToken: "victim_token",
        cardLast4: "9999",
        cardBrand: "visa",
        ...TEST_FUTURE_CARD_EXPIRY,
        supersedesCardMethodId: null,
      });
      ctx.auditRepo.events = []; // discard the direct-insert's own history — this test only cares about replaceCard's effects.
      const cardCountBefore = ctx.cards.byId.size;

      await expect(
        ctx.debitCardMethodService.replaceCard({
          agreementId: victimAgreementId,
          payer: PAYER, // attacker owns PAYER, but PAYER is not victimAgreementId's debtor
          newCardToken: "attacker_token",
          cardLast4: "0000",
          cardBrand: null,
          ...TEST_FUTURE_CARD_EXPIRY,
          reason: "attacker-supplied reason",
          actingUserId: PAYER_USER_ID,
        }),
      ).rejects.toThrow(ForbiddenError);

      // Zero markReplaced: the victim's original card is untouched.
      const stillOriginal = await ctx.cards.findById(originalCard.id);
      expect(stillOriginal?.status).toBe("active");
      expect(stillOriginal?.replacedAt).toBeNull();
      // Zero insert: no new card row was created for the attacker's replacement.
      expect(ctx.cards.byId.size).toBe(cardCountBefore);
      // No success audit was written for this rejected attempt.
      expect(ctx.auditRepo.events).toHaveLength(0);
    });

    it("CARD-R08-8: caller owns the agreement's CREDITOR profile, but the creditor is not the debtor -> register/replace rejected as applicable", async () => {
      const creditorUserId = "creditor-user-1";
      ctx.profileOwners.set(CREDITOR.profileKind, CREDITOR.profileId, creditorUserId);

      await expect(
        ctx.debitCardMethodService.registerCard({
          agreementId, // debtor is PAYER, creditor is CREDITOR
          payer: CREDITOR, // caller genuinely owns CREDITOR, and CREDITOR genuinely is a party...
          cardToken: "x",
          cardLast4: "4242",
          cardBrand: null,
          ...TEST_FUTURE_CARD_EXPIRY,
          actingUserId: creditorUserId, // ...but is not the debtor.
        }),
      ).rejects.toThrow(ForbiddenError);

      await ctx.debitCardMethodService.registerCard({
        agreementId,
        payer: PAYER,
        cardToken: "legit_token",
        cardLast4: "4242",
        cardBrand: "visa",
        ...TEST_FUTURE_CARD_EXPIRY,
        actingUserId: PAYER_USER_ID,
      });
      await expect(
        ctx.debitCardMethodService.replaceCard({
          agreementId,
          payer: CREDITOR,
          newCardToken: "y",
          cardLast4: "1111",
          cardBrand: null,
          ...TEST_FUTURE_CARD_EXPIRY,
          reason: "x",
          actingUserId: creditorUserId,
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
