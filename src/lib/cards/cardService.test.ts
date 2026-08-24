import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestCardServices } from "./testFakes";

const CARDHOLDER = { kind: "personal" as const, id: "cardholder-profile-1" };
const CARDHOLDER_USER_ID = "cardholder-user-1";
const STRANGER_USER_ID = "stranger-user-1";
const REVIEWER_USER_ID = "reviewer-1";

describe("CardService (PRSprint 24 — docs/prsprints/PRSPRINT_24_DEBIT_CARD_ISSUANCE_CARD_LIFECYCLE.md)", () => {
  let ctx: ReturnType<typeof createTestCardServices>;

  beforeEach(async () => {
    ctx = createTestCardServices();
    ctx.verificationCtx.profileOwners.set(CARDHOLDER.kind, CARDHOLDER.id, CARDHOLDER_USER_ID);
  });

  async function verifyCardholder() {
    await ctx.verificationCtx.verificationService.submitFullVerificationRequest(CARDHOLDER.kind, CARDHOLDER.id);
    await ctx.verificationCtx.verificationService.recordManualVerificationDecision({
      actingRole: "platform_owner",
      profileKind: CARDHOLDER.kind,
      profileId: CARDHOLDER.id,
      decision: "verified",
      reviewerUserId: REVIEWER_USER_ID,
      reason: null,
    });
  }

  describe("requestCard", () => {
    it(
      "PRSprint 22/24: card creation without required KYC/KYB verification is rejected — a card is never issued to an unverified party",
      async () => {
        await expect(
          ctx.cardService.requestCard({
            idempotencyKey: "req-unverified-1",
            cardholder: CARDHOLDER,
            cardType: "virtual",
            actingUserId: CARDHOLDER_USER_ID,
          }),
        ).rejects.toThrow(ValidationError);
      },
    );

    it("issues a virtual card once the cardholder is verified — reaches 'issued' status with provider-supplied non-sensitive metadata", async () => {
      await verifyCardholder();
      const card = await ctx.cardService.requestCard({
        idempotencyKey: "req-virtual-1",
        cardholder: CARDHOLDER,
        cardType: "virtual",
        actingUserId: CARDHOLDER_USER_ID,
      });
      expect(card.status).toBe("issued");
      expect(card.providerCardRef).toMatch(/^sandbox_card_/);
      expect(card.cardLast4).toHaveLength(4);
    });

    it("requires a shipping address for a physical card", async () => {
      await verifyCardholder();
      await expect(
        ctx.cardService.requestCard({
          idempotencyKey: "req-physical-1",
          cardholder: CARDHOLDER,
          cardType: "physical",
          actingUserId: CARDHOLDER_USER_ID,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("PRSprint 24: rejects a stranger requesting a card for someone else's profile (cross-tenant)", async () => {
      await verifyCardholder();
      await expect(
        ctx.cardService.requestCard({
          idempotencyKey: "req-cross-1",
          cardholder: CARDHOLDER,
          cardType: "virtual",
          actingUserId: STRANGER_USER_ID,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("PRSprint 24: duplicate issuance request (same idempotency key) returns the same card, never issuing a second one", async () => {
      await verifyCardholder();
      const input = { idempotencyKey: "req-dup-1", cardholder: CARDHOLDER, cardType: "virtual" as const, actingUserId: CARDHOLDER_USER_ID };
      const first = await ctx.cardService.requestCard(input);
      const second = await ctx.cardService.requestCard(input);
      expect(second.id).toBe(first.id);
      const [a, b] = await Promise.all([ctx.cardService.requestCard(input), ctx.cardService.requestCard(input)]);
      expect(a.id).toBe(first.id);
      expect(b.id).toBe(first.id);
    });

    it("PRSprint 24: never returns a PAN, CVV, or PIN — only opaque provider reference and non-sensitive display metadata", async () => {
      await verifyCardholder();
      const card = await ctx.cardService.requestCard({
        idempotencyKey: "req-nosecrets-1",
        cardholder: CARDHOLDER,
        cardType: "virtual",
        actingUserId: CARDHOLDER_USER_ID,
      });
      const serialized = JSON.stringify(card);
      expect(serialized).not.toMatch(/\bcvv\b/i);
      expect(serialized).not.toMatch(/\bpin\b/i);
      // cardLast4 is exactly 4 digits, never a full PAN.
      expect(card.cardLast4).toMatch(/^\d{4}$/);
    });
  });

  describe("activateCard", () => {
    it("PRSprint 24: activation before issuance is rejected — a 'requested'/'pending_issuance' card cannot be activated", async () => {
      // Force a card into "requested" by bypassing the provider call: insert directly via the repo.
      const record = await ctx.cards.insert({
        idempotencyKey: "act-early-1",
        individualProfileId: CARDHOLDER.id,
        organizationId: null,
        cardType: "virtual",
        providerName: "sandbox_card_issuing_mock",
        shippingAddress: null,
        requestedByUserId: CARDHOLDER_USER_ID,
        supersedesCardId: null,
      });
      await expect(ctx.cardService.activateCard(record.id, CARDHOLDER_USER_ID)).rejects.toThrow(ValidationError);
    });

    it("activates an issued card", async () => {
      await verifyCardholder();
      const card = await ctx.cardService.requestCard({
        idempotencyKey: "act-1",
        cardholder: CARDHOLDER,
        cardType: "virtual",
        actingUserId: CARDHOLDER_USER_ID,
      });
      const activated = await ctx.cardService.activateCard(card.id, CARDHOLDER_USER_ID);
      expect(activated.status).toBe("active");
      expect(activated.activatedAt).not.toBeNull();
    });

    it("PRSprint 24: rejects a stranger activating another user's card (cross-tenant)", async () => {
      await verifyCardholder();
      const card = await ctx.cardService.requestCard({
        idempotencyKey: "act-cross-1",
        cardholder: CARDHOLDER,
        cardType: "virtual",
        actingUserId: CARDHOLDER_USER_ID,
      });
      await expect(ctx.cardService.activateCard(card.id, STRANGER_USER_ID)).rejects.toThrow(ForbiddenError);
    });
  });

  describe("freeze / unfreeze", () => {
    async function issueAndActivate() {
      await verifyCardholder();
      const card = await ctx.cardService.requestCard({
        idempotencyKey: `freeze-setup-${randomUUID()}`,
        cardholder: CARDHOLDER,
        cardType: "virtual",
        actingUserId: CARDHOLDER_USER_ID,
      });
      return ctx.cardService.activateCard(card.id, CARDHOLDER_USER_ID);
    }

    it("freezes and unfreezes an active card", async () => {
      const active = await issueAndActivate();
      const frozen = await ctx.cardService.freezeCard(active.id, CARDHOLDER_USER_ID, "Suspicious activity.");
      expect(frozen.status).toBe("frozen");
      const unfrozen = await ctx.cardService.unfreezeCard(active.id, CARDHOLDER_USER_ID);
      expect(unfrozen.status).toBe("active");
    });

    it("PRSprint 24: rejects a stranger freezing another user's card (unauthorized freeze)", async () => {
      const active = await issueAndActivate();
      await expect(ctx.cardService.freezeCard(active.id, STRANGER_USER_ID, "malicious")).rejects.toThrow(ForbiddenError);
    });

    it("freezing an already-frozen card is idempotent", async () => {
      const active = await issueAndActivate();
      const first = await ctx.cardService.freezeCard(active.id, CARDHOLDER_USER_ID, "reason");
      const second = await ctx.cardService.freezeCard(active.id, CARDHOLDER_USER_ID, "reason");
      expect(second.status).toBe("frozen");
      expect(second.frozenAt?.getTime()).toBe(first.frozenAt?.getTime());
    });

    it("unfreezing an already-active card is idempotent (a no-op, not an error)", async () => {
      const active = await issueAndActivate();
      const result = await ctx.cardService.unfreezeCard(active.id, CARDHOLDER_USER_ID);
      expect(result.status).toBe("active");
    });

    it("PRSprint 24: invalid lifecycle transition — unfreezing a canceled card is rejected", async () => {
      const active = await issueAndActivate();
      const canceled = await ctx.cardService.cancelCard(active.id, CARDHOLDER_USER_ID, "No longer needed.");
      await expect(ctx.cardService.unfreezeCard(canceled.id, CARDHOLDER_USER_ID)).rejects.toThrow(ValidationError);
    });
  });

  describe("reportLostOrStolen", () => {
    it("marks the card lost/stolen and issues a linked replacement in one call", async () => {
      await verifyCardholder();
      const card = await ctx.cardService.requestCard({
        idempotencyKey: "lost-1",
        cardholder: CARDHOLDER,
        cardType: "virtual",
        actingUserId: CARDHOLDER_USER_ID,
      });
      const activated = await ctx.cardService.activateCard(card.id, CARDHOLDER_USER_ID);
      const { oldCard, replacement } = await ctx.cardService.reportLostOrStolen(activated.id, CARDHOLDER_USER_ID, "stolen");
      expect(oldCard.status).toBe("replaced");
      expect(replacement.status).toBe("issued");
      expect(replacement.supersedesCardId).toBe(oldCard.id);
      expect(replacement.providerCardRef).not.toBe(oldCard.providerCardRef);
    });

    it("PRSprint 24: operation on a canceled card is rejected — cannot report an already-canceled card lost/stolen", async () => {
      await verifyCardholder();
      const card = await ctx.cardService.requestCard({
        idempotencyKey: "lost-canceled-1",
        cardholder: CARDHOLDER,
        cardType: "virtual",
        actingUserId: CARDHOLDER_USER_ID,
      });
      const activated = await ctx.cardService.activateCard(card.id, CARDHOLDER_USER_ID);
      const canceled = await ctx.cardService.cancelCard(activated.id, CARDHOLDER_USER_ID, "No longer needed.");
      await expect(ctx.cardService.reportLostOrStolen(canceled.id, CARDHOLDER_USER_ID, "lost")).rejects.toThrow(ValidationError);
    });
  });

  describe("cancelCard", () => {
    it("cancels an active card, requiring a reason", async () => {
      await verifyCardholder();
      const card = await ctx.cardService.requestCard({
        idempotencyKey: "cancel-1",
        cardholder: CARDHOLDER,
        cardType: "virtual",
        actingUserId: CARDHOLDER_USER_ID,
      });
      const activated = await ctx.cardService.activateCard(card.id, CARDHOLDER_USER_ID);
      await expect(ctx.cardService.cancelCard(activated.id, CARDHOLDER_USER_ID, "")).rejects.toThrow(ValidationError);
      const canceled = await ctx.cardService.cancelCard(activated.id, CARDHOLDER_USER_ID, "No longer needed.");
      expect(canceled.status).toBe("canceled");
    });

    it("cancellation is idempotent", async () => {
      await verifyCardholder();
      const card = await ctx.cardService.requestCard({
        idempotencyKey: "cancel-idempotent-1",
        cardholder: CARDHOLDER,
        cardType: "virtual",
        actingUserId: CARDHOLDER_USER_ID,
      });
      const first = await ctx.cardService.cancelCard(card.id, CARDHOLDER_USER_ID, "reason");
      const second = await ctx.cardService.cancelCard(card.id, CARDHOLDER_USER_ID, "reason again");
      expect(second.status).toBe("canceled");
      expect(second.closedReason).toBe(first.closedReason); // second call is a no-op, doesn't overwrite
    });

    it("PRSprint 24: rejects a stranger cancelling another user's card (cross-tenant, admin-unauthorized-equivalent)", async () => {
      await verifyCardholder();
      const card = await ctx.cardService.requestCard({
        idempotencyKey: "cancel-cross-1",
        cardholder: CARDHOLDER,
        cardType: "virtual",
        actingUserId: CARDHOLDER_USER_ID,
      });
      await expect(ctx.cardService.cancelCard(card.id, STRANGER_USER_ID, "reason")).rejects.toThrow(ForbiddenError);
    });
  });

  describe("audit", () => {
    it("audits every lifecycle transition", async () => {
      await verifyCardholder();
      const card = await ctx.cardService.requestCard({
        idempotencyKey: "audit-1",
        cardholder: CARDHOLDER,
        cardType: "virtual",
        actingUserId: CARDHOLDER_USER_ID,
      });
      await ctx.cardService.activateCard(card.id, CARDHOLDER_USER_ID);
      const actions = ctx.auditRepo.events.map((e) => e.action);
      expect(actions).toContain("card_requested");
      expect(actions).toContain("card_issued");
      expect(actions).toContain("card_activated");
    });
  });
});
