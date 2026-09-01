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

      // Decision 2 (canonical connection): relinking the SAME agreement to the SAME relationship is
      // idempotent — a no-op, never an error, and never a second link.
      const relinked = await ctx.relationshipService.linkAgreement(relationship.id, created.agreement.id, creditorUserId);
      expect(relinked.id).toBe(relationship.id);
      expect(relinked.currentAgreementId).toBe(created.agreement.id);

      await ctx.agreementService.submitDraft(created.agreement.id, creditorUserId);
      await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
      await ctx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });

      let synced = await ctx.relationshipService.syncFromAgreement(relationship.id, creditorUserId);
      expect(synced.status).toBe("signature_pending");

      await ctx.agreementService.signAgreement(created.agreement.id, debtorUserId);
      await ctx.agreementService.signAgreement(created.agreement.id, creditorUserId);
      synced = await ctx.relationshipService.syncFromAgreement(relationship.id, creditorUserId);
      expect(synced.status).toBe("signed");
    });

    /**
     * Decision 2 (canonical connection): "Connection identity = the two parties. Agreement identity =
     * each individual agreement" — a relationship may govern more than one agreement, and doing so
     * must never corrupt its own status tracking.
     */
    it("test 19/20 — a second agreement between the same two parties, same roles, links to the SAME connection while the first is still non-terminal, without corrupting relationship status", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorProfileId } = await createLinkedRelationship();

      const first = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.relationshipService.linkAgreement(relationship.id, first.agreement.id, creditorUserId);

      const second = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms({ description: "A second, unrelated loan between the same two people" }),
      });
      // First agreement is still a draft (non-terminal) — same roles, so no shared-slot conflict.
      const linked = await ctx.relationshipService.linkAgreement(relationship.id, second.agreement.id, creditorUserId);
      expect(linked.id).toBe(relationship.id);
      expect(linked.currentAgreementId).toBe(second.agreement.id);
      expect(ctx.agreementLinker.linked.get(second.agreement.id)).toBe(relationship.id);

      // No duplicate connection was ever created for this pair.
      const creditorRelationships = await ctx.relationshipService.listRelationshipsForParty(creditorUserId, {
        kind: "personal",
        id: creditorProfileId,
      });
      expect(creditorRelationships.map((r) => r.id)).toEqual([relationship.id]);

      // Both agreements independently point at the one canonical relationship.
      const bothAgreements = await ctx.agreementService.listAgreementsForRelationship(relationship.id);
      expect(bothAgreements.map((a) => a.id).sort()).toEqual([first.agreement.id, second.agreement.id].sort());
    });

    /**
     * current_agreement_id audit (G — same-role concurrent agreements): proves the one place
     * `current_agreement_id` DOES feed a financial decision (RelationshipCurrentAgreementRoleReader,
     * used by `resolveEffectiveRole` for funding/payout role validation) never lets a mandate,
     * card registration, or funding-account assignment "jump" from one agreement to the other purely
     * because `current_agreement_id` has moved on to the newer one. Each agreement's own mandate
     * stays independently keyed by ITS OWN agreement id (AchMandateService never reads
     * current_agreement_id at all — see achMandateService.ts), so A1's mandate must remain exactly
     * as it was after A2 links and current_agreement_id advances past it.
     */
    it("test G — mandate/account state stays scoped to the specific agreement it belongs to; current_agreement_id moving to the newer agreement never migrates or invalidates the older agreement's mandate", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId } = await createLinkedRelationship();

      const debtorAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "sandbox_bank_ref_shared",
        maskedLast4: "5555",
        institutionDisplayName: "Shared Funding Bank",
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(debtorAccount.id, "verified");
      await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: debtorAccount.id,
        usage: "funding",
      });

      const first = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.relationshipService.linkAgreement(relationship.id, first.agreement.id, creditorUserId);
      expect(await ctx.mandates.isActiveForAgreement(first.agreement.id)).toBe(true);
      const firstMandate = ctx.mandates.activeByAgreement.get(first.agreement.id);
      expect(firstMandate?.financialAccountId).toBe(debtorAccount.id);

      // Second, same-role, non-terminal agreement — current_agreement_id now advances to it.
      const second = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms({ description: "A second, unrelated loan between the same two people" }),
      });
      const linked = await ctx.relationshipService.linkAgreement(relationship.id, second.agreement.id, creditorUserId);
      expect(linked.currentAgreementId).toBe(second.agreement.id); // confirmed: current_agreement_id has moved on

      // A1's own mandate is completely unaffected — still active, still pointing at the same account.
      expect(await ctx.mandates.isActiveForAgreement(first.agreement.id)).toBe(true);
      expect(ctx.mandates.activeByAgreement.get(first.agreement.id)?.financialAccountId).toBe(debtorAccount.id);

      // A2 independently and correctly got its OWN mandate (same shared funding account, its own agreement id).
      expect(await ctx.mandates.isActiveForAgreement(second.agreement.id)).toBe(true);
      expect(ctx.mandates.activeByAgreement.get(second.agreement.id)?.financialAccountId).toBe(debtorAccount.id);

      // Operations on A1/A2 (financial-account role reads) remain scoped to the actual current roles —
      // resolveEffectiveRole reads current_agreement_id only to determine the CURRENT role mapping,
      // which is identical for A1 and A2 here (same creditor/debtor), so no cross-contamination: the
      // creditor still never owns the funding slot, even after current_agreement_id moved to A2.
      const creditorSlots = await ctx.relationshipFinancialAccountService.getRelationshipAccountsForParticipant(relationship.id, creditorUserId);
      const creditorFundingSlot = creditorSlots.find((s) => s.usage === "funding")!;
      expect(creditorFundingSlot.mine).toBe(false);
      expect(creditorFundingSlot.account).toBeNull();
    });

    /**
     * Decision 1 (reversed-role safety) — the mandatory investigation's central finding, made
     * concrete: a relationship's funding/payout slots are a single shared pair of resources, so two
     * NON-TERMINAL agreements with reversed roles cannot safely share one connection at the same time.
     */
    it("test 18 (conflict half) — refuses to link a role-reversed second agreement while the first (opposite-role) agreement is still non-terminal, without creating a second connection", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId } = await createLinkedRelationship();

      const first = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.relationshipService.linkAgreement(relationship.id, first.agreement.id, creditorUserId);

      // Second agreement: same two people, ROLES REVERSED — the original debtor is now the creditor.
      const reversed = await ctx.agreementService.createDraft({
        creatorUserId: debtorUserId,
        creditor: { kind: "personal", id: debtorProfileId },
        debtor: { kind: "personal", id: creditorProfileId },
        ...baseTerms({ description: "Reversed-role loan" }),
      });

      await expect(ctx.relationshipService.linkAgreement(relationship.id, reversed.agreement.id, debtorUserId)).rejects.toThrow(
        /reversed|swapped/i,
      );
      expect(await ctx.agreementService.getAgreement(reversed.agreement.id, debtorUserId).then((d) => d.agreement.relationshipId)).toBeNull();

      // Still exactly one connection for this pair — refusing to link never spawns a second one.
      const relationships = await ctx.relationshipService.listRelationshipsForParty(creditorUserId, { kind: "personal", id: creditorProfileId });
      expect(relationships.map((r) => r.id)).toEqual([relationship.id]);
    });

    /**
     * Decision 1 (reversed-role safety) — the common, safe case: once the first (opposite-role)
     * agreement is genuinely terminal, the SAME canonical connection may govern the role-reversed
     * second agreement. Proves the connection itself is role-neutral (Decision 1's own requirement:
     * "Do NOT solve reversed roles by creating a second Connection") and that financial-account role
     * validation correctly follows the CURRENT agreement's real roles afterward, not the stale
     * relationship_participant.role captured when the connection was first created.
     */
    it("test 18 (reuse half) — once the first agreement is terminal, the SAME connection safely governs a role-reversed second agreement, and funding/payout validation follows the new roles", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId } = await createLinkedRelationship();

      const first = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.relationshipService.linkAgreement(relationship.id, first.agreement.id, creditorUserId);
      await ctx.agreementService.submitDraft(first.agreement.id, creditorUserId);
      await ctx.agreementService.cancelAgreement(first.agreement.id, creditorUserId, "no longer needed");
      const firstAfterCancel = await ctx.agreementService.getAgreement(first.agreement.id, creditorUserId);
      expect(firstAfterCancel.agreement.status).toBe("mutually_canceled");

      const reversed = await ctx.agreementService.createDraft({
        creatorUserId: debtorUserId,
        creditor: { kind: "personal", id: debtorProfileId },
        debtor: { kind: "personal", id: creditorProfileId },
        ...baseTerms({ description: "Reversed-role loan, after the first is done" }),
      });

      const linked = await ctx.relationshipService.linkAgreement(relationship.id, reversed.agreement.id, debtorUserId);
      expect(linked.id).toBe(relationship.id); // the SAME canonical connection — never a second one
      expect(linked.currentAgreementId).toBe(reversed.agreement.id);

      const relationships = await ctx.relationshipService.listRelationshipsForParty(creditorUserId, { kind: "personal", id: creditorProfileId });
      expect(relationships.map((r) => r.id)).toEqual([relationship.id]);

      // Financial-account role validation now correctly follows THIS agreement's real roles: the
      // original debtor (now the creditor) may manage the payout slot; the original creditor (now the
      // debtor) may manage the funding slot — the reverse of what relationship_participant.role alone
      // would say.
      const originalDebtorAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "sandbox_bank_ref_reversed_payout",
        maskedLast4: "9001",
        institutionDisplayName: "New Creditor Bank",
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(originalDebtorAccount.id, "verified");
      const payoutAssignment = await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: originalDebtorAccount.id,
        usage: "payout",
      });
      expect(payoutAssignment.usage).toBe("payout");

      // The original creditor (now the debtor) attempting to manage the PAYOUT slot must be rejected —
      // they are the debtor of the current agreement now, funding is their slot, not payout.
      const originalCreditorAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "sandbox_bank_ref_reversed_funding",
        maskedLast4: "9002",
        institutionDisplayName: "New Debtor Bank",
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(originalCreditorAccount.id, "verified");
      await expect(
        ctx.relationshipFinancialAccountService.assignAccount({
          relationshipId: relationship.id,
          actingUserId: creditorUserId,
          financialAccountId: originalCreditorAccount.id,
          usage: "payout",
        }),
      ).rejects.toThrow(/only the creditor/i);
    });

    /**
     * current_agreement_id / relationship_participant.role audit (item 3) — the full sequential
     * reversed-role scenario end to end: same relationship id, no duplicate connection,
     * getRelationship's effectiveRole correctly reflects Agreement #2's real (reversed) roles even
     * though relationship_participant.role is still permanently stamped from Agreement #1, funding/
     * payout ownership follows Agreement #2, and authorization remains correct throughout.
     */
    it("test G/H (item 3) — after a role-reversed reuse, getRelationship's effectiveRole reflects the CURRENT agreement, never the stale stored relationship_participant.role", async () => {
      const { relationship, creditorUserId, creditorProfileId, debtorUserId, debtorProfileId } = await createLinkedRelationship();

      // Agreement #1: A creditor / B debtor.
      const first = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });
      await ctx.relationshipService.linkAgreement(relationship.id, first.agreement.id, creditorUserId);

      // Before any agreement's role has been superseded: effectiveRole still matches the stored role.
      const beforeReversal = await ctx.relationshipService.getRelationship(relationship.id, creditorUserId);
      const mineBeforeReversal = beforeReversal.participants.find((p) => p.individualProfileId === creditorProfileId)!;
      expect(mineBeforeReversal.role).toBe("creditor");
      expect(mineBeforeReversal.effectiveRole).toBe("creditor");

      // Agreement #1 terminates.
      await ctx.agreementService.submitDraft(first.agreement.id, creditorUserId);
      await ctx.agreementService.cancelAgreement(first.agreement.id, creditorUserId, "no longer needed");

      // Agreement #2: A debtor / B creditor — SAME canonical connection, roles reversed.
      const second = await ctx.agreementService.createDraft({
        creatorUserId: debtorUserId,
        creditor: { kind: "personal", id: debtorProfileId },
        debtor: { kind: "personal", id: creditorProfileId },
        ...baseTerms({ description: "Reversed-role loan" }),
      });
      const linked = await ctx.relationshipService.linkAgreement(relationship.id, second.agreement.id, debtorUserId);
      expect(linked.id).toBe(relationship.id); // same relationship id — no duplicate connection

      // "Connections page still shows one connection."
      const allRelationships = await ctx.relationshipService.listRelationshipsForParty(creditorUserId, { kind: "personal", id: creditorProfileId });
      expect(allRelationships.map((r) => r.id)).toEqual([relationship.id]);

      // getRelationship's effectiveRole now reflects Agreement #2's real roles — A is debtor, B is
      // creditor — even though relationship_participant.role is still permanently stamped "creditor"
      // for A from Agreement #1 (legacy/storage role, never mutated by a later agreement).
      const afterReversal = await ctx.relationshipService.getRelationship(relationship.id, creditorUserId);
      const aParticipant = afterReversal.participants.find((p) => p.individualProfileId === creditorProfileId)!;
      const bParticipant = afterReversal.participants.find((p) => p.individualProfileId === debtorProfileId)!;
      expect(aParticipant.role).toBe("creditor"); // stale legacy/storage value — unchanged, by design
      expect(aParticipant.effectiveRole).toBe("debtor"); // correct, current-agreement value
      expect(bParticipant.role).toBe("debtor");
      expect(bParticipant.effectiveRole).toBe("creditor");

      // Funding/payout ownership follows Agreement #2 (the new creditor, B, may manage payout).
      const bAccount = await ctx.relationshipFinancialAccountService.addAccount({
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
        accountType: "bank_account",
        providerName: "sandbox",
        providerAccountRef: "sandbox_bank_ref_g_h_payout",
        maskedLast4: "7001",
        institutionDisplayName: "B's Bank",
      });
      await ctx.relationshipFinancialAccountService.applyVerificationResult(bAccount.id, "verified");
      const payoutAssignment = await ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: debtorUserId,
        financialAccountId: bAccount.id,
        usage: "payout",
      });
      expect(payoutAssignment.usage).toBe("payout");

      // Authorization remains correct: a genuine stranger still cannot view or act on this connection.
      const strangerUserId = randomUUID();
      await expect(ctx.relationshipService.getRelationship(relationship.id, strangerUserId)).rejects.toThrow(ForbiddenError);
    });

    it("Missing-connection remediation (mandatory command): 'Choose Existing Connection' must not let a user link an agreement to a relationship with a different counterparty", async () => {
      const { creditorUserId, creditorProfileId, debtorProfileId } = await createLinkedRelationship();

      const created = await ctx.agreementService.createDraft({
        creatorUserId: creditorUserId,
        creditor: { kind: "personal", id: creditorProfileId },
        debtor: { kind: "personal", id: debtorProfileId },
        ...baseTerms(),
      });

      // A second, unrelated relationship for the SAME creditor, but with a different counterparty.
      const strangerUserId = randomUUID();
      const strangerProfileId = randomUUID();
      ctx.profileOwners.set("personal", strangerProfileId, strangerUserId);
      ctx.users.set("stranger@example.com", strangerUserId);
      const { relationship: unrelatedRelationship, invitation } = await ctx.relationshipInvitationService.createInvitation({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        inviteeEmail: "stranger@example.com",
        inviteeRole: "debtor",
      });
      await ctx.relationshipInvitationService.acceptInvitation({
        invitationId: invitation.id,
        actingUserId: strangerUserId,
        actingParty: { kind: "personal", id: strangerProfileId },
      });

      await expect(ctx.relationshipService.linkAgreement(unrelatedRelationship.id, created.agreement.id, creditorUserId)).rejects.toThrow(
        /not with the agreement's counterparty/i,
      );
      expect(unrelatedRelationship.currentAgreementId).toBeNull();
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
      await ctx.agreementService.signAgreement(created.agreement.id, debtorUserId);
      await ctx.agreementService.signAgreement(created.agreement.id, creditorUserId);

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
