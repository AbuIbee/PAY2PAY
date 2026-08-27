import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { grantStepUp } from "@/lib/staff/testFakes";
import { createTestRelationshipServices } from "./testFakes";

/**
 * Permanent regression suite (connection P2P-EZ2R-V3MM / P2P-T7UJ-JM2W remediation): proves zero
 * cross-user financial-account contamination platform-wide, not just within a single relationship.
 *
 * Three independent users, two concurrent relationships sharing one participant (Alice) — the
 * highest-risk shape, since a single authenticated session legitimately touches two relationships and
 * must never let data or write access bleed between them:
 *
 *   Relationship 1: Alice (creditor) <-> Bob (debtor)
 *   Relationship 2: Alice (creditor) <-> Carol (debtor)
 *
 * This suite must never be deleted or weakened without an equivalent replacement — it is the concrete
 * proof behind RelationshipFinancialAccountService's own requireUsageMatchesRole /
 * requireAccountBelongsToParticipant / getRelationshipAccountsForParticipant invariants (see that
 * file's doc comments), exercised across multiple users and relationships rather than one at a time.
 */
describe("cross-user financial-account isolation (connection P2P-EZ2R-V3MM/P2P-T7UJ-JM2W remediation)", () => {
  let ctx: ReturnType<typeof createTestRelationshipServices>;

  beforeEach(() => {
    ctx = createTestRelationshipServices();
  });

  async function setupThreeUserTopology() {
    const aliceUserId = randomUUID();
    const aliceProfileId = randomUUID();
    const bobUserId = randomUUID();
    const bobProfileId = randomUUID();
    const carolUserId = randomUUID();
    const carolProfileId = randomUUID();
    ctx.profileOwners.set("personal", aliceProfileId, aliceUserId);
    ctx.profileOwners.set("personal", bobProfileId, bobUserId);
    ctx.profileOwners.set("personal", carolProfileId, carolUserId);
    ctx.users.set("bob@example.com", bobUserId);
    ctx.users.set("carol@example.com", carolUserId);

    const invite1 = await ctx.relationshipInvitationService.createInvitation({
      actingUserId: aliceUserId,
      actingParty: { kind: "personal", id: aliceProfileId },
      inviteeEmail: "bob@example.com",
      inviteeRole: "debtor",
    });
    await ctx.relationshipInvitationService.acceptInvitation({
      invitationId: invite1.invitation.id,
      actingUserId: bobUserId,
      actingParty: { kind: "personal", id: bobProfileId },
    });

    const invite2 = await ctx.relationshipInvitationService.createInvitation({
      actingUserId: aliceUserId,
      actingParty: { kind: "personal", id: aliceProfileId },
      inviteeEmail: "carol@example.com",
      inviteeRole: "debtor",
    });
    await ctx.relationshipInvitationService.acceptInvitation({
      invitationId: invite2.invitation.id,
      actingUserId: carolUserId,
      actingParty: { kind: "personal", id: carolProfileId },
    });

    const relationship1 = invite1.relationship;
    const relationship2 = invite2.relationship;

    const accountA = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: aliceUserId,
      actingParty: { kind: "personal", id: aliceProfileId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "ref_account_a",
      maskedLast4: "1001",
      institutionDisplayName: "Alice Bank",
    });
    await ctx.relationshipFinancialAccountService.applyVerificationResult(accountA.id, "verified");

    const accountB = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: bobUserId,
      actingParty: { kind: "personal", id: bobProfileId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "ref_account_b",
      maskedLast4: "2002",
      institutionDisplayName: "Bob Bank",
    });
    await ctx.relationshipFinancialAccountService.applyVerificationResult(accountB.id, "verified");

    const accountC = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: carolUserId,
      actingParty: { kind: "personal", id: carolProfileId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "ref_account_c",
      maskedLast4: "3003",
      institutionDisplayName: "Carol Bank",
    });
    await ctx.relationshipFinancialAccountService.applyVerificationResult(accountC.id, "verified");

    // Legitimate assignments only — Account A is reused across both relationships by its own owner
    // (Alice), which is a real, allowed pattern (same owner, two separate assignment rows), not
    // contamination.
    await ctx.relationshipFinancialAccountService.assignAccount({
      relationshipId: relationship1.id,
      actingUserId: bobUserId,
      financialAccountId: accountB.id,
      usage: "funding",
    });
    await ctx.relationshipFinancialAccountService.assignAccount({
      relationshipId: relationship1.id,
      actingUserId: aliceUserId,
      financialAccountId: accountA.id,
      usage: "payout",
    });
    await ctx.relationshipFinancialAccountService.assignAccount({
      relationshipId: relationship2.id,
      actingUserId: carolUserId,
      financialAccountId: accountC.id,
      usage: "funding",
    });
    await ctx.relationshipFinancialAccountService.assignAccount({
      relationshipId: relationship2.id,
      actingUserId: aliceUserId,
      financialAccountId: accountA.id,
      usage: "payout",
    });

    return {
      aliceUserId,
      aliceProfileId,
      bobUserId,
      bobProfileId,
      carolUserId,
      carolProfileId,
      relationship1,
      relationship2,
      accountA,
      accountB,
      accountC,
    };
  }

  describe("A. read isolation — via the real getRelationshipAccountsForParticipant, not a mock", () => {
    it("Bob (debtor, relationship 1) sees his own funding slot in full and only a readiness flag for Alice's payout slot", async () => {
      const { relationship1, bobUserId } = await setupThreeUserTopology();
      const slots = await ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship1.id, bobUserId);
      const mine = slots.find((s) => s.mine)!;
      const theirs = slots.find((s) => !s.mine)!;
      expect(mine.usage).toBe("funding");
      expect(mine.account?.maskedLast4).toBe("2002");
      expect(mine.account?.institutionDisplayName).toBe("Bob Bank");
      expect(theirs.usage).toBe("payout");
      expect(theirs.account).toBeNull();
      expect(theirs.ready).toBe(true);
    });

    it("Alice (creditor, relationship 1) sees her own payout slot in full and only a readiness flag for Bob's funding slot", async () => {
      const { relationship1, aliceUserId } = await setupThreeUserTopology();
      const slots = await ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship1.id, aliceUserId);
      const mine = slots.find((s) => s.mine)!;
      const theirs = slots.find((s) => !s.mine)!;
      expect(mine.usage).toBe("payout");
      expect(mine.account?.maskedLast4).toBe("1001");
      expect(theirs.usage).toBe("funding");
      expect(theirs.account).toBeNull();
      expect(theirs.ready).toBe(true);
    });

    it("Alice's own relationship-2 read never surfaces Bob's or Account B's data, even though Alice is a legitimate participant there too", async () => {
      const { relationship2, aliceUserId } = await setupThreeUserTopology();
      const slots = await ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship2.id, aliceUserId);
      const serialized = JSON.stringify(slots);
      expect(serialized).not.toContain("2002");
      expect(serialized).not.toContain("Bob Bank");
      const mine = slots.find((s) => s.mine)!;
      expect(mine.account?.maskedLast4).toBe("1001");
    });

    it("Bob (a true bystander to relationship 2) is rejected outright, not merely shown redacted data", async () => {
      const { relationship2, bobUserId } = await setupThreeUserTopology();
      await expect(
        ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship2.id, bobUserId),
      ).rejects.toThrow(ForbiddenError);
    });

    it("neither Bob's nor Carol's bank details ever appear in the other's slot view", async () => {
      const { relationship1, relationship2, bobUserId, carolUserId } = await setupThreeUserTopology();
      const bobView = await ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship1.id, bobUserId);
      const carolView = await ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship2.id, carolUserId);
      expect(JSON.stringify(bobView)).not.toContain("3003");
      expect(JSON.stringify(bobView)).not.toContain("Carol Bank");
      expect(JSON.stringify(carolView)).not.toContain("2002");
      expect(JSON.stringify(carolView)).not.toContain("Bob Bank");
    });
  });

  describe("B. write isolation — an account belonging to a participant of a DIFFERENT relationship", () => {
    it("rejects Alice assigning Bob's (relationship-1) account into relationship 2's payout slot", async () => {
      const { relationship2, aliceUserId, accountB } = await setupThreeUserTopology();
      await expect(
        ctx.relationshipFinancialAccountService.assignAccount({
          relationshipId: relationship2.id,
          actingUserId: aliceUserId,
          financialAccountId: accountB.id,
          usage: "payout",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects Carol assigning Bob's (relationship-1) account into relationship 2's funding slot", async () => {
      const { relationship2, carolUserId, accountB } = await setupThreeUserTopology();
      await expect(
        ctx.relationshipFinancialAccountService.assignAccount({
          relationshipId: relationship2.id,
          actingUserId: carolUserId,
          financialAccountId: accountB.id,
          usage: "funding",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects Alice replacing relationship 1's payout account with Carol's (relationship-2) account", async () => {
      const { relationship1, aliceUserId, accountC } = await setupThreeUserTopology();
      const sessionId = randomUUID();
      await grantStepUp(ctx.staffCtx, aliceUserId, sessionId);
      await expect(
        ctx.relationshipFinancialAccountService.replaceAccount({
          relationshipId: relationship1.id,
          actingUserId: aliceUserId,
          actingSessionId: sessionId,
          financialAccountId: accountC.id,
          usage: "payout",
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("C. role/usage isolation combined with cross-relationship identity", () => {
    it("rejects Bob assigning his own account into relationship 2's payout slot — he isn't even a participant there", async () => {
      const { relationship2, bobUserId, accountB } = await setupThreeUserTopology();
      await expect(
        ctx.relationshipFinancialAccountService.assignAccount({
          relationshipId: relationship2.id,
          actingUserId: bobUserId,
          financialAccountId: accountB.id,
          usage: "payout",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects Carol assigning her OWN account into the payout slot — ownership alone is not sufficient without the matching role", async () => {
      const { relationship2, carolUserId, accountC } = await setupThreeUserTopology();
      await expect(
        ctx.relationshipFinancialAccountService.assignAccount({
          relationshipId: relationship2.id,
          actingUserId: carolUserId,
          financialAccountId: accountC.id,
          usage: "payout",
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("D. capstone — the negative space is empty", () => {
    it("each of Alice/Bob/Carol sees exactly their own account in each relationship they belong to, and nothing else, ever", async () => {
      const { relationship1, relationship2, aliceUserId, bobUserId, carolUserId } = await setupThreeUserTopology();

      const aliceRel1 = await ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship1.id, aliceUserId);
      const aliceRel2 = await ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship2.id, aliceUserId);
      const bobRel1 = await ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship1.id, bobUserId);
      const carolRel2 = await ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship2.id, carolUserId);

      expect(aliceRel1.find((s) => s.mine)?.account?.maskedLast4).toBe("1001");
      expect(aliceRel2.find((s) => s.mine)?.account?.maskedLast4).toBe("1001");
      expect(bobRel1.find((s) => s.mine)?.account?.maskedLast4).toBe("2002");
      expect(carolRel2.find((s) => s.mine)?.account?.maskedLast4).toBe("3003");

      // Bob is a true bystander to relationship 2, Carol to relationship 1 — both must be rejected
      // outright, never handed a redacted-but-present response.
      await expect(
        ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship2.id, bobUserId),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship1.id, carolUserId),
      ).rejects.toThrow(ForbiddenError);

      // No response above ever contains a masked last-4 or institution name belonging to a user
      // other than the one who owns that slot — each value legitimately appears only in the one
      // response where it is the caller's own slot.
      const responses = [aliceRel1, aliceRel2, bobRel1, carolRel2];
      for (const value of ["2002", "Bob Bank", "3003", "Carol Bank"]) {
        const occurrences = responses.filter((slots) => JSON.stringify(slots).includes(value));
        expect(occurrences.length).toBeLessThanOrEqual(1);
      }
    });
  });
});
