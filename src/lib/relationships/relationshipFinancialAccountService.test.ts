import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, StepUpRequiredError, ValidationError } from "@/lib/errors";
import { grantStepUp } from "@/lib/staff/testFakes";
import { createTestRelationshipServices } from "./testFakes";

describe("RelationshipFinancialAccountService", () => {
  let ctx: ReturnType<typeof createTestRelationshipServices>;

  beforeEach(() => {
    ctx = createTestRelationshipServices();
  });

  async function createLinkedRelationship() {
    const creditorUserId = randomUUID();
    const creditorProfileId = randomUUID();
    const debtorUserId = randomUUID();
    const debtorProfileId = randomUUID();
    ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);
    ctx.users.set("debtor@example.com", debtorUserId);
    const { relationship, invitation } = await ctx.relationshipInvitationService.createInvitation({
      actingUserId: creditorUserId,
      actingParty: { kind: "personal", id: creditorProfileId },
      inviteeEmail: "debtor@example.com",
      inviteeRole: "debtor",
    });
    await ctx.relationshipInvitationService.acceptInvitation({
      invitationId: invitation.id,
      actingUserId: debtorUserId,
      actingParty: { kind: "personal", id: debtorProfileId },
    });
    return { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId };
  }

  describe("addAccount / ownership", () => {
    it("adds a party-owned account in pending_verification status", async () => {
      const userId = randomUUID();
      const profileId = randomUUID();
      ctx.profileOwners.set("personal", profileId, userId);
      const account = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: userId,
        actingParty: { kind: "personal", id: profileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_1",
        maskedLast4: "1234",
        institutionDisplayName: "Test Bank",
      });
      expect(account.status).toBe("pending_verification");
      expect(account.individualProfileId).toBe(profileId);
    });

    it("requires maskedLast4/cardExpiryMonth/cardExpiryYear for a debit_card account, and rejects an invalid expiry", async () => {
      const userId = randomUUID();
      const profileId = randomUUID();
      ctx.profileOwners.set("personal", profileId, userId);

      await expect(
        ctx.relationshipFinancialAccountService.addAccount({
          actingUserId: userId,
          actingParty: { kind: "personal", id: profileId },
          accountType: "debit_card",
          providerName: "sandbox",
          providerAccountRef: "card_ref_1",
          maskedLast4: null,
          institutionDisplayName: null,
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        ctx.relationshipFinancialAccountService.addAccount({
          actingUserId: userId,
          actingParty: { kind: "personal", id: profileId },
          accountType: "debit_card",
          providerName: "sandbox",
          providerAccountRef: "card_ref_1",
          maskedLast4: "4242",
          institutionDisplayName: null,
          cardExpiryMonth: 13,
          cardExpiryYear: 2030,
        }),
      ).rejects.toThrow(ValidationError);

      const account = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: userId,
        actingParty: { kind: "personal", id: profileId },
        accountType: "debit_card",
        providerName: "sandbox",
        providerAccountRef: "card_ref_1",
        maskedLast4: "4242",
        institutionDisplayName: null,
        cardExpiryMonth: 6,
        cardExpiryYear: 2030,
        cardBrand: "visa",
      });
      expect(account.cardExpiryMonth).toBe(6);
      expect(account.cardExpiryYear).toBe(2030);
      expect(account.cardBrand).toBe("visa");
    });

    it(
      "PRSprint 22 (docs/prsprints/PRSPRINT_22_KYC_KYB_FINANCIAL_ACCOUNT_PROVISIONING.md): a repeated " +
        "provisioning request (same providerAccountRef) returns the existing account idempotently, " +
        "never creating a second row for the same underlying bank account/card",
      async () => {
        const userId = randomUUID();
        const profileId = randomUUID();
        ctx.profileOwners.set("personal", profileId, userId);
        const input = {
          actingUserId: userId,
          actingParty: { kind: "personal" as const, id: profileId },
          accountType: "bank_account" as const,
          providerName: "sandbox",
          providerAccountRef: "ref_retry_1",
          maskedLast4: "1234",
          institutionDisplayName: "Test Bank",
        };
        const first = await ctx.relationshipFinancialAccountService.addAccount(input);
        const second = await ctx.relationshipFinancialAccountService.addAccount(input);
        expect(second.id).toBe(first.id);

        const all = await ctx.relationshipFinancialAccountService.listAccountsForParty(userId, { kind: "personal", id: profileId });
        expect(all.filter((a) => a.providerAccountRef === "ref_retry_1")).toHaveLength(1);
      },
    );

    it(
      "re-adding the same providerAccountRef after the original was disabled creates a fresh account, not a resurrected disabled one",
      async () => {
        const userId = randomUUID();
        const profileId = randomUUID();
        ctx.profileOwners.set("personal", profileId, userId);
        const input = {
          actingUserId: userId,
          actingParty: { kind: "personal" as const, id: profileId },
          accountType: "bank_account" as const,
          providerName: "sandbox",
          providerAccountRef: "ref_readd_1",
          maskedLast4: "1234",
          institutionDisplayName: "Test Bank",
        };
        const first = await ctx.relationshipFinancialAccountService.addAccount(input);
        await ctx.relationshipFinancialAccountService.disableAccount({
          financialAccountId: first.id,
          actingUserId: userId,
          actingParty: { kind: "personal", id: profileId },
          reason: "No longer using this account.",
        });
        const second = await ctx.relationshipFinancialAccountService.addAccount(input);
        expect(second.id).not.toBe(first.id);
        expect(second.status).toBe("pending_verification");
      },
    );

    it("rejects adding an account for a profile the caller does not own", async () => {
      const ownerUserId = randomUUID();
      const profileId = randomUUID();
      ctx.profileOwners.set("personal", profileId, ownerUserId);
      await expect(
        ctx.relationshipFinancialAccountService.addAccount({
          actingUserId: randomUUID(),
          actingParty: { kind: "personal", id: profileId },
          accountType: "bank_account",
          providerName: "sandbox",
          providerAccountRef: "ref_1",
          maskedLast4: null,
          institutionDisplayName: null,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("requires the change_payout_configuration capability for a business account, and rejects a manager who lacks it (default role set does not include it)", async () => {
      const ownerUserId = randomUUID();
      const businessId = randomUUID();
      const managerUserId = randomUUID();
      ctx.profileOwners.set("business", businessId, ownerUserId);
      await ctx.staffCtx.staffMembers.insert({
        businessProfileId: businessId,
        userId: managerUserId,
        role: "manager",
        customRoleId: null,
        isAuthorizedRepresentative: false,
      });
      await expect(
        ctx.relationshipFinancialAccountService.addAccount({
          actingUserId: managerUserId,
          actingParty: { kind: "business", id: businessId },
          accountType: "bank_account",
          providerName: "sandbox",
          providerAccountRef: "ref_1",
          maskedLast4: null,
          institutionDisplayName: null,
        }),
      ).rejects.toThrow(ForbiddenError);

      // A custom role explicitly granted the capability succeeds.
      const grantedUserId = randomUUID();
      const customRole = await ctx.staffCtx.customRoles.insert({
        businessProfileId: businessId,
        name: "Treasury",
        permissions: ["change_payout_configuration"],
      });
      await ctx.staffCtx.staffMembers.insert({
        businessProfileId: businessId,
        userId: grantedUserId,
        role: "custom",
        customRoleId: customRole.id,
        isAuthorizedRepresentative: false,
      });
      const account = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: grantedUserId,
        actingParty: { kind: "business", id: businessId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_2",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      expect(account.organizationId).toBe(businessId);

      // The owner always bypasses the capability check.
      const ownerAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: ownerUserId,
        actingParty: { kind: "business", id: businessId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_3",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      expect(ownerAccount.organizationId).toBe(businessId);
    });
  });

  describe("assignAccount", () => {
    it("rejects assigning an account the participant does not own", async () => {
      const { relationship, debtorUserId, debtorProfileId } = await createLinkedRelationship();
      const otherUserId = randomUUID();
      const otherProfileId = randomUUID();
      ctx.profileOwners.set("personal", otherProfileId, otherUserId);
      const otherAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: otherUserId,
        actingParty: { kind: "personal", id: otherProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_x",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(otherAccount.id, "verified");
      void debtorProfileId;
      await expect(
        ctx.relationshipFinancialAccountService.assignAccount({
          relationshipId: relationship.id,
          actingUserId: debtorUserId,
          financialAccountId: otherAccount.id,
          usage: "funding",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects assigning an unverified account", async () => {
      const { relationship, debtorUserId, debtorProfileId } = await createLinkedRelationship();
      const account = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_1",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await expect(
        ctx.relationshipFinancialAccountService.assignAccount({
          relationshipId: relationship.id,
          actingUserId: debtorUserId,
          financialAccountId: account.id,
          usage: "funding",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a second active assignment for the same slot (use replaceAccount instead)", async () => {
      const { relationship, debtorUserId, debtorProfileId } = await createLinkedRelationship();
      const accountA = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_a",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(accountA.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: accountA.id,
        usage: "funding",
      });

      const accountB = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_b",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(accountB.id, "verified");
      await expect(
        ctx.relationshipFinancialAccountService.assignAccount({
          relationshipId: relationship.id,
          actingUserId: debtorUserId,
          financialAccountId: accountB.id,
          usage: "funding",
        }),
      ).rejects.toThrow(ConflictError);
    });

    it("advances the relationship to financial_accounts_ready once both funding and payout are assigned and verified", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId } = await createLinkedRelationship();
      const funding = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_funding",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(funding.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: funding.id,
        usage: "funding",
      });
      expect((await ctx.relationships.findById(relationship.id))?.status).toBe("financial_setup_pending");

      const payout = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_payout",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(payout.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: creditorUserId,
        financialAccountId: payout.id,
        usage: "payout",
      });
      expect((await ctx.relationships.findById(relationship.id))?.status).toBe("financial_accounts_ready");
    });
  });

  describe("replaceAccount", () => {
    it("supersedes the prior assignment, preserving history, and notifies the counterparty", async () => {
      const { relationship, creditorUserId, debtorUserId, debtorProfileId } = await createLinkedRelationship();
      const accountA = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_a",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(accountA.id, "verified");
      const original = await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: accountA.id,
        usage: "funding",
      });

      const accountB = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_b",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(accountB.id, "verified");
      const debtorSessionId = randomUUID();
      await grantStepUp(ctx.staffCtx, debtorUserId, debtorSessionId);
      const replacement = await ctx.relationshipFinancialAccountService.replaceAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        actingSessionId: debtorSessionId,
        financialAccountId: accountB.id,
        usage: "funding",
      });

      expect(replacement.id).not.toBe(original.id);
      const supersededRow = ctx.assignments.byId.get(original.id);
      expect(supersededRow?.status).toBe("superseded");
      expect(supersededRow?.supersededBy).toBe(replacement.id);

      const creditorNotifications = await ctx.notifyCtx.events.listForUser(creditorUserId);
      expect(creditorNotifications.some((n) => n.notificationType === "relationship_funding_account_replaced")).toBe(true);

      // SPRINT_19_FraudRisk_SecurityHardening §12: "frequent bank changes" risk signal is recorded
      // on a real replacement (docs/SECURITY_MODEL.md threat #16, payout redirection).
      const riskSignals = await ctx.riskCtx.riskEventService.listForUserAdmin("admin-test-1", "platform_owner", debtorUserId);
      expect(riskSignals.some((r) => r.signalType === "frequent_bank_connection_change" && r.relatedResourceId === replacement.id)).toBe(true);
    });

    it("is idempotent when replacing with the same account", async () => {
      const { relationship, debtorUserId, debtorProfileId } = await createLinkedRelationship();
      const account = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_a",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(account.id, "verified");
      const first = await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: account.id,
        usage: "funding",
      });
      const debtorSessionId = randomUUID();
      await grantStepUp(ctx.staffCtx, debtorUserId, debtorSessionId);
      const second = await ctx.relationshipFinancialAccountService.replaceAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        actingSessionId: debtorSessionId,
        financialAccountId: account.id,
        usage: "funding",
      });
      expect(second.id).toBe(first.id);
      // No risk signal for an idempotent same-account no-op or a first-time assignment — only a real
      // replacement is a "bank change."
      const riskSignals = await ctx.riskCtx.riskEventService.listForUserAdmin("admin-test-1", "platform_owner", debtorUserId);
      expect(riskSignals.filter((r) => r.signalType === "frequent_bank_connection_change")).toHaveLength(0);
    });

    it("rejects replacing an account without a fresh MFA step-up (docs/SECURITY_MODEL.md threat #16, payout redirection)", async () => {
      const { relationship, debtorUserId, debtorProfileId } = await createLinkedRelationship();
      const account = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_stepup",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(account.id, "verified");
      await expect(
        ctx.relationshipFinancialAccountService.replaceAccount({
          relationshipId: relationship.id,
          actingUserId: debtorUserId,
          actingSessionId: randomUUID(), // no grantStepUp for this session
          financialAccountId: account.id,
          usage: "funding",
        }),
      ).rejects.toThrow(StepUpRequiredError);
    });

    it("rejects a participant replacing another participant's assigned account", async () => {
      const { relationship, creditorUserId, debtorUserId, debtorProfileId } = await createLinkedRelationship();
      const account = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_a",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(account.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: account.id,
        usage: "funding",
      });

      const creditorOwnAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: (await ctx.participants.listForRelationship(relationship.id)).find((p) => p.role === "creditor")!.individualProfileId! },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_c",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(creditorOwnAccount.id, "verified");
      await expect(
        ctx.relationshipFinancialAccountService.replaceAccount({
          relationshipId: relationship.id,
          actingUserId: creditorUserId,
          actingSessionId: randomUUID(),
          financialAccountId: creditorOwnAccount.id,
          usage: "funding",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    // SPRINT_19_FraudRisk_SecurityHardening: two truly concurrent replaceAccount calls for the same
    // slot both read `existing` before either writes. This previously threw a raw, unhandled DB
    // constraint error for the loser (and — a separate, more severe bug this same fix closed — even
    // the ordinary *sequential* case briefly held two "active" rows and would have violated the DB's
    // real partial unique index outside this in-memory fake). Now: exactly one winner, one clean
    // ConflictError for the loser, and never two active rows for the same slot.
    it("two truly concurrent replaceAccount calls for the same slot: exactly one wins, the other gets a clean ConflictError, never two active rows", async () => {
      const { relationship, debtorUserId, debtorProfileId } = await createLinkedRelationship();
      const original = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_conc_orig",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(original.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: original.id,
        usage: "funding",
      });

      const accountA = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_conc_a",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(accountA.id, "verified");
      const accountB = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "ref_conc_b",
        maskedLast4: null,
        institutionDisplayName: null,
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(accountB.id, "verified");

      const sessionA = randomUUID();
      const sessionB = randomUUID();
      await grantStepUp(ctx.staffCtx, debtorUserId, sessionA);
      await grantStepUp(ctx.staffCtx, debtorUserId, sessionB);

      const results = await Promise.allSettled([
        ctx.relationshipFinancialAccountService.replaceAccount({
          relationshipId: relationship.id,
          actingUserId: debtorUserId,
          actingSessionId: sessionA,
          financialAccountId: accountA.id,
          usage: "funding",
        }),
        ctx.relationshipFinancialAccountService.replaceAccount({
          relationshipId: relationship.id,
          actingUserId: debtorUserId,
          actingSessionId: sessionB,
          financialAccountId: accountB.id,
          usage: "funding",
        }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect(rejected && (rejected as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

      const activeRows = (await ctx.assignments.listForRelationship(relationship.id)).filter((a) => a.status === "active" && a.usage === "funding");
      expect(activeRows).toHaveLength(1); // never two active rows for the same slot.
    });
  });

  describe("admin connector — masked view", () => {
    it("rejects a non-admin caller and never exposes providerAccountRef", async () => {
      const { relationship, debtorUserId, debtorProfileId } = await createLinkedRelationship();
      const account = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "super_secret_provider_ref",
        maskedLast4: "1234",
        institutionDisplayName: "Test Bank",
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(account.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: account.id,
        usage: "funding",
      });

      await expect(
        ctx.relationshipFinancialAccountService.getRelationshipAccountsForAdmin(relationship.id, randomUUID(), "member"),
      ).rejects.toThrow(ForbiddenError);

      const adminView = await ctx.relationshipFinancialAccountService.getRelationshipAccountsForAdmin(relationship.id, randomUUID(), "platform_admin");
      expect(adminView).toHaveLength(1);
      expect(JSON.stringify(adminView)).not.toContain("super_secret_provider_ref");
      expect(adminView[0]?.maskedLast4).toBe("1234");
    });
  });
});
