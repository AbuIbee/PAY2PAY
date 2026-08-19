import { describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestBetaInviteService } from "./testFakes";

describe("BetaInviteService", () => {
  it("rejects code generation by a non-admin role", async () => {
    const { betaInviteService } = createTestBetaInviteService();
    await expect(
      betaInviteService.generateCode({ code: "WELCOME1", createdByUserId: "user-1", note: null, actingRole: "member" }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("allows a platform admin to generate a code", async () => {
    const { betaInviteService } = createTestBetaInviteService();
    const record = await betaInviteService.generateCode({ code: "WELCOME1", createdByUserId: "admin-1", note: "launch batch 1", actingRole: "platform_admin" });
    expect(record.code).toBe("WELCOME1");
    expect(record.usedByUserId).toBeNull();
  });

  it("checkCodeIsRedeemable passes for a valid unused code and rejects an unknown one, with the same generic message either way (no enumeration side channel)", async () => {
    const { betaInviteService } = createTestBetaInviteService();
    await betaInviteService.generateCode({ code: "REAL1", createdByUserId: "admin-1", note: null, actingRole: "platform_admin" });

    await expect(betaInviteService.checkCodeIsRedeemable("REAL1")).resolves.toBeUndefined();
    await expect(betaInviteService.checkCodeIsRedeemable("FAKE1")).rejects.toThrow(ValidationError);
    await expect(betaInviteService.checkCodeIsRedeemable("FAKE1")).rejects.toThrow(/invalid or has already been used/i);
  });

  it("consumeCode atomically claims a code — a second attempt to consume the same code fails", async () => {
    const { betaInviteService } = createTestBetaInviteService();
    await betaInviteService.generateCode({ code: "ONETIME", createdByUserId: "admin-1", note: null, actingRole: "platform_admin" });

    const first = await betaInviteService.consumeCode("ONETIME", "user-1");
    expect(first?.usedByUserId).toBe("user-1");

    const second = await betaInviteService.consumeCode("ONETIME", "user-2");
    expect(second).toBeNull();
  });

  it("two genuinely concurrent consumeCode calls for the same code: exactly one wins", async () => {
    const { betaInviteService } = createTestBetaInviteService();
    await betaInviteService.generateCode({ code: "RACE1", createdByUserId: "admin-1", note: null, actingRole: "platform_admin" });

    const [a, b] = await Promise.all([betaInviteService.consumeCode("RACE1", "user-a"), betaInviteService.consumeCode("RACE1", "user-b")]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it("rejects listing codes by a non-admin role", async () => {
    const { betaInviteService } = createTestBetaInviteService();
    await expect(betaInviteService.listCodes("member")).rejects.toThrow(ForbiddenError);
  });
});
