import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestDebitCardMethodService, TEST_FUTURE_CARD_EXPIRY, TEST_PAST_CARD_EXPIRY } from "./testFakes";

const PAYER = { profileKind: "personal" as const, profileId: "payer-1" };
const PAYER_USER_ID = "payer-user-1";
const OTHER_USER_ID = "other-user-1";

describe("DebitCardMethodService", () => {
  let ctx: ReturnType<typeof createTestDebitCardMethodService>;
  const agreementId = randomUUID();

  beforeEach(() => {
    ctx = createTestDebitCardMethodService();
    ctx.profileOwners.set(PAYER.profileKind, PAYER.profileId, PAYER_USER_ID);
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
});
