import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestRelationshipServices } from "./testFakes";

function baseTerms(overrides: Record<string, unknown> = {}) {
  return {
    category: "personal_loan" as const,
    description: "Loan for car repair",
    originalAmountMinorUnits: 120_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 20_000,
    installmentAmountMinorUnits: 20_000,
    frequency: "monthly" as const,
    firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    feeAllocation: "debtor_pays" as const,
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Borrower may request hardship relief; no interest or penalty added.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

describe("RelationshipService", () => {
  let ctx: ReturnType<typeof createTestRelationshipServices>;

  beforeEach(() => {
    ctx = createTestRelationshipServices();
  });

  /** Builds a relationship with both participants active (past the invitation handshake), mirroring what RelationshipInvitationService produces by the time acceptInvitation completes. */
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

  describe("resolveActingParticipant / isolation", () => {
    it("rejects an unrelated user from viewing or acting on a relationship", async () => {
      const { relationship } = await createLinkedRelationship();
      const strangerUserId = randomUUID();
      await expect(ctx.relationshipService.getRelationship(relationship.id, strangerUserId)).rejects.toThrow(ForbiddenError);
      await expect(ctx.relationshipService.close(relationship.id, strangerUserId)).rejects.toThrow(ForbiddenError);
    });

    it("recognizes an authorized business staff member acting on behalf of a business participant", async () => {
      const creditorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const businessOwnerId = randomUUID();
      const businessId = randomUUID();
      const staffUserId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.profileOwners.set("business", businessId, businessOwnerId);
      await ctx.staffCtx.staffMembers.insert({
        businessProfileId: businessId,
        userId: staffUserId,
        role: "manager",
        customRoleId: null,
        isAuthorizedRepresentative: true,
      });

      const { relationship, invitation, rawToken } = await ctx.relationshipInvitationService.createInvitation({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        inviteeEmail: "biz@example.com",
        inviteeRole: "debtor",
      });
      await ctx.relationshipInvitationService.acceptInvitation({
        invitationId: invitation.id,
        actingUserId: staffUserId,
        actingParty: { kind: "business", id: businessId },
        rawToken,
      });
      const detail = await ctx.relationshipService.getRelationship(relationship.id, staffUserId);
      expect(detail.participants).toHaveLength(2);
    });
  });

  describe("linkAgreement / syncFromAgreement — agreement connector", () => {
    it("links an agreement, writes the reverse agreement.relationship_id pointer, and syncs status as the agreement progresses", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId } = await createLinkedRelationship();

      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });

      const linked = await ctx.relationshipService.linkAgreement(relationship.id, created.agreement.id, creditorUserId);
      expect(linked.status).toBe("agreement_pending");
      expect(linked.currentAgreementId).toBe(created.agreement.id);
      expect(ctx.agreementLinker.linked.get(created.agreement.id)).toBe(relationship.id);

      await expect(ctx.relationshipService.linkAgreement(relationship.id, created.agreement.id, creditorUserId)).rejects.toThrow(ValidationError);

      await ctx.agreementService.submitDraft(created.agreement.id, creditorUserId);
      await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await ctx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });

      let synced = await ctx.relationshipService.syncFromAgreement(relationship.id, creditorUserId);
      expect(synced.status).toBe("signature_pending");

      await ctx.agreementService.signAgreement(created.agreement.id, creditorUserId);
      await ctx.agreementService.signAgreement(created.agreement.id, debtorUserId);
      synced = await ctx.relationshipService.syncFromAgreement(relationship.id, creditorUserId);
      expect(synced.status).toBe("signed");
    });

    it("auto-authorizes an ACH mandate (ACH connector) when a verified bank-account funding source is already assigned at link time", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId } = await createLinkedRelationship();

      const debtorAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "sandbox_bank_ref_1",
        maskedLast4: "1234",
        institutionDisplayName: "Test Bank",
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(debtorAccount.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: debtorAccount.id,
        usage: "funding",
      });

      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.relationshipService.linkAgreement(relationship.id, created.agreement.id, creditorUserId);

      expect(await ctx.mandates.isActiveForAgreement(created.agreement.id)).toBe(true);
      const mandateEntry = ctx.mandates.activeByAgreement.get(created.agreement.id);
      expect(mandateEntry?.financialAccountId).toBe(debtorAccount.id);
    });

    it("auto-registers a debit_card_method (debit-card connector) when a verified debit-card funding source is already assigned at link time", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId } = await createLinkedRelationship();

      const debtorAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "debit_card",
        providerName: "sandbox",
        providerAccountRef: "sandbox_card_ref_1",
        maskedLast4: "4242",
        institutionDisplayName: null,
        cardExpiryMonth: 6,
        cardExpiryYear: 2030,
        cardBrand: "visa",
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(debtorAccount.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: debtorAccount.id,
        usage: "funding",
      });

      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.relationshipService.linkAgreement(relationship.id, created.agreement.id, creditorUserId);

      expect(await ctx.cards.isActiveForAgreement(created.agreement.id)).toBe(true);
      const cardEntry = ctx.cards.activeByAgreement.get(created.agreement.id);
      expect(cardEntry?.financialAccountId).toBe(debtorAccount.id);

      const check = await ctx.relationshipService.checkActivationPrerequisites(relationship.id);
      expect(check.reasons).not.toContain("card_missing");
    });

    it("reports card_missing when a verified debit-card funding source has no active card registration for the linked agreement", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId } = await createLinkedRelationship();

      const debtorAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "debit_card",
        providerName: "sandbox",
        providerAccountRef: "sandbox_card_ref_2",
        maskedLast4: "4242",
        institutionDisplayName: null,
        cardExpiryMonth: 6,
        cardExpiryYear: 2030,
        cardBrand: "visa",
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(debtorAccount.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: debtorAccount.id,
        usage: "funding",
      });

      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.relationshipService.linkAgreement(relationship.id, created.agreement.id, creditorUserId);
      // Simulate the card having been revoked/replaced out-of-band after linkAgreement's own auto-registration.
      ctx.cards.activeByAgreement.delete(created.agreement.id);

      const check = await ctx.relationshipService.checkActivationPrerequisites(relationship.id);
      expect(check.reasons).toContain("card_missing");
    });
  });

  describe("checkActivationPrerequisites / activate", () => {
    it("reports every blocking reason individually, and clears them one at a time", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId } = await createLinkedRelationship();

      let check = await ctx.relationshipService.checkActivationPrerequisites(relationship.id);
      expect(check.eligible).toBe(false);
      expect(check.reasons).toContain("agreement_missing");
      expect(check.reasons).toContain("funding_account_missing");
      expect(check.reasons).toContain("payout_account_missing");

      const fundingAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "sandbox_bank_ref_1",
        maskedLast4: "1234",
        institutionDisplayName: "Test Bank",
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(fundingAccount.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: fundingAccount.id,
        usage: "funding",
      });
      check = await ctx.relationshipService.checkActivationPrerequisites(relationship.id);
      expect(check.reasons).not.toContain("funding_account_missing");
      expect(check.reasons).toContain("payout_account_missing");

      const payoutAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "sandbox_bank_ref_2",
        maskedLast4: "5678",
        institutionDisplayName: "Test Bank 2",
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(payoutAccount.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: creditorUserId,
        financialAccountId: payoutAccount.id,
        usage: "payout",
      });

      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.relationshipService.linkAgreement(relationship.id, created.agreement.id, creditorUserId);
      check = await ctx.relationshipService.checkActivationPrerequisites(relationship.id);
      expect(check.reasons).toContain("signature_missing");
      expect(check.reasons).not.toContain("mandate_missing"); // auto-authorized by linkAgreement's ACH connector

      await ctx.agreementService.submitDraft(created.agreement.id, creditorUserId);
      await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await ctx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });
      await ctx.agreementService.signAgreement(created.agreement.id, creditorUserId);
      await ctx.agreementService.signAgreement(created.agreement.id, debtorUserId);

      check = await ctx.relationshipService.checkActivationPrerequisites(relationship.id);
      expect(check.eligible).toBe(true);
      expect(check.reasons).toHaveLength(0);

      const activated = await ctx.relationshipService.activate(relationship.id, creditorUserId);
      expect(activated.status).toBe("active");
      expect(activated.activatedAt).not.toBeNull();

      // idempotent re-activation
      const again = await ctx.relationshipService.activate(relationship.id, creditorUserId);
      expect(again.status).toBe("active");
    });

    it("rejects activation while prerequisites remain unmet", async () => {
      const { relationship, creditorUserId } = await createLinkedRelationship();
      await expect(ctx.relationshipService.activate(relationship.id, creditorUserId)).rejects.toThrow(ValidationError);
    });
  });

  describe("restrict — admin connector", () => {
    it("rejects a non-admin caller, and restricts as a platform admin", async () => {
      const { relationship, creditorUserId } = await createLinkedRelationship();
      await expect(ctx.relationshipService.restrict(relationship.id, creditorUserId, "member", "policy review")).rejects.toThrow(ForbiddenError);

      const adminUserId = randomUUID();
      const restricted = await ctx.relationshipService.restrict(relationship.id, adminUserId, "platform_admin", "policy review");
      expect(restricted.status).toBe("restricted");
      expect(restricted.restrictedAt).not.toBeNull();
    });
  });

  describe("close", () => {
    it("either active participant may close; closing is idempotent", async () => {
      const { relationship, debtorUserId } = await createLinkedRelationship();
      const closed = await ctx.relationshipService.close(relationship.id, debtorUserId);
      expect(closed.status).toBe("closed");
      const again = await ctx.relationshipService.close(relationship.id, debtorUserId);
      expect(again.status).toBe("closed");
    });
  });

  describe("getRelationshipForAdmin — admin connector", () => {
    it("rejects a non-admin caller and audits an admin view", async () => {
      const { relationship } = await createLinkedRelationship();
      const nonAdminUserId = randomUUID();
      await expect(ctx.relationshipService.getRelationshipForAdmin(relationship.id, nonAdminUserId, "member")).rejects.toThrow(ForbiddenError);

      const adminUserId = randomUUID();
      const detail = await ctx.relationshipService.getRelationshipForAdmin(relationship.id, adminUserId, "platform_admin");
      expect(detail.relationship.id).toBe(relationship.id);
      expect(detail.participants).toHaveLength(2);
    });
  });

  describe("getRelationshipEvidence / getRelationshipEvidenceSignedUrl — document/evidence connector", () => {
    it("rejects when no agreement is linked yet", async () => {
      const { relationship, creditorUserId } = await createLinkedRelationship();
      await expect(ctx.relationshipService.getRelationshipEvidence(relationship.id, creditorUserId)).rejects.toThrow(ValidationError);
    });

    it("a relationship participant sees the linked agreement's evidence via Sprint 7's own visibility rules; an unrelated user is rejected", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId } = await createLinkedRelationship();
      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.relationshipService.linkAgreement(relationship.id, created.agreement.id, creditorUserId);

      const shared = await ctx.evidenceService.uploadEvidence({
        agreementId: created.agreement.id,
        actingUserId: creditorUserId,
        documentType: "invoice",
        description: "Repair invoice",
        fileName: "invoice.pdf",
        contentType: "application/pdf",
        content: new Uint8Array([1, 2, 3]),
        visibility: "shared",
        sharedWithWitnesses: false,
        ipAddress: null,
        deviceInfo: null,
      });
      const debtorPrivate = await ctx.evidenceService.uploadEvidence({
        agreementId: created.agreement.id,
        actingUserId: debtorUserId,
        documentType: "other",
        description: "Debtor's private note",
        fileName: "note.pdf",
        contentType: "application/pdf",
        content: new Uint8Array([4, 5, 6]),
        visibility: "private",
        sharedWithWitnesses: false,
        ipAddress: null,
        deviceInfo: null,
      });

      // The creditor sees the shared item but not the debtor's private upload — Sprint 7's own visibility rule, unmodified.
      const creditorView = await ctx.relationshipService.getRelationshipEvidence(relationship.id, creditorUserId);
      expect(creditorView.map((e) => e.id)).toContain(shared.id);
      expect(creditorView.map((e) => e.id)).not.toContain(debtorPrivate.id);

      // The debtor sees both (their own private upload plus the shared item).
      const debtorView = await ctx.relationshipService.getRelationshipEvidence(relationship.id, debtorUserId);
      expect(debtorView.map((e) => e.id).sort()).toEqual([shared.id, debtorPrivate.id].sort());

      // An unrelated third party is rejected at the relationship-participation gate, before evidence's own check ever runs.
      const strangerUserId = randomUUID();
      await expect(ctx.relationshipService.getRelationshipEvidence(relationship.id, strangerUserId)).rejects.toThrow(ForbiddenError);

      const signedUrl = await ctx.relationshipService.getRelationshipEvidenceSignedUrl(relationship.id, shared.id, creditorUserId);
      expect(signedUrl).toBeTruthy();
      await expect(ctx.relationshipService.getRelationshipEvidenceSignedUrl(relationship.id, shared.id, strangerUserId)).rejects.toThrow(ForbiddenError);
    });
  });
});
