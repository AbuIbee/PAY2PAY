import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { createTestCardServices, createTestCardWebhookService } from "./testFakes";

const CARDHOLDER = { kind: "personal" as const, id: "webhook-cardholder-1" };
const CARDHOLDER_USER_ID = "webhook-cardholder-user-1";
const REVIEWER_USER_ID = "webhook-reviewer-1";

describe("CardWebhookService (PRSprint 24)", () => {
  let ctx: ReturnType<typeof createTestCardServices>;
  let webhookCtx: ReturnType<typeof createTestCardWebhookService>;
  let providerCardRef: string;

  beforeEach(async () => {
    ctx = createTestCardServices();
    webhookCtx = createTestCardWebhookService(ctx);
    ctx.verificationCtx.profileOwners.set(CARDHOLDER.kind, CARDHOLDER.id, CARDHOLDER_USER_ID);
    await ctx.verificationCtx.verificationService.submitFullVerificationRequest(CARDHOLDER.kind, CARDHOLDER.id);
    await ctx.verificationCtx.verificationService.recordManualVerificationDecision({
      actingRole: "platform_owner",
      profileKind: CARDHOLDER.kind,
      profileId: CARDHOLDER.id,
      decision: "verified",
      reviewerUserId: REVIEWER_USER_ID,
      reason: null,
    });
    const card = await ctx.cardService.requestCard({
      idempotencyKey: "webhook-setup-1",
      cardholder: CARDHOLDER,
      cardType: "virtual",
      actingUserId: CARDHOLDER_USER_ID,
    });
    providerCardRef = card.providerCardRef!;
  });

  function signedWebhook(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, signatureHeader: ctx.provider.signWebhookPayload(rawBody) };
  }

  it("PRSprint 24: rejects a spoofed (stale/tampered) webhook signature", async () => {
    const rawBody = JSON.stringify({ providerEventId: "evt-1", eventType: "card_transaction.authorization", providerCardRef });
    await expect(webhookCtx.cardWebhookService.receiveWebhook({ rawBody, signatureHeader: "not-a-real-signature" })).rejects.toThrow(ForbiddenError);
  });

  it("processes an authorization event for a known card", async () => {
    const event = signedWebhook({
      providerEventId: "evt-auth-1",
      eventType: "card_transaction.authorization",
      providerCardRef,
      amountMinorUnits: 1_500,
      currency: "USD",
      merchantDisplayName: "Coffee Shop",
    });
    const result = await webhookCtx.cardWebhookService.receiveWebhook(event);
    expect(result.status).toBe("processed");
    const events = await webhookCtx.events.listForCard((await ctx.cards.findByProviderCardRef(providerCardRef))!.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("authorization");
  });

  it("PRSprint 24: duplicate provider event — a truly concurrent redelivery processes exactly once", async () => {
    const event = signedWebhook({ providerEventId: "evt-dup-1", eventType: "card_transaction.clearing", providerCardRef, amountMinorUnits: 500, currency: "USD" });
    const [a, b] = await Promise.all([webhookCtx.cardWebhookService.receiveWebhook(event), webhookCtx.cardWebhookService.receiveWebhook(event)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["duplicate", "processed"]);
  });

  it("handles an event for an unknown/stale card reference without throwing (never fails the provider's retry loop)", async () => {
    const event = signedWebhook({ providerEventId: "evt-unknown-1", eventType: "card_transaction.authorization", providerCardRef: "sandbox_card_does_not_exist", amountMinorUnits: 100, currency: "USD" });
    const result = await webhookCtx.cardWebhookService.receiveWebhook(event);
    expect(result.status).toBe("unknown_card");
  });

  it(
    "never posts a Phase 5 ledger entry — card transactions are visibility-only, not a second money-movement path " +
      "(structural: CardWebhookService's own constructor accepts no LedgerService dependency at all — see cardWebhookService.ts)",
    async () => {
      const event = signedWebhook({ providerEventId: "evt-noledger-1", eventType: "card_transaction.settlement", providerCardRef, amountMinorUnits: 2_000, currency: "USD" });
      const result = await webhookCtx.cardWebhookService.receiveWebhook(event);
      expect(result.status).toBe("processed");
    },
  );
});
