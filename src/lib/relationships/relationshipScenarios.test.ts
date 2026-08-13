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
    firstPaymentDate: "2026-02-01",
    feeAllocation: "debtor_pays" as const,
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Borrower may request hardship relief; no interest or penalty added.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

describe("Sprint 18A relationship scenarios", () => {
  let ctx: ReturnType<typeof createTestRelationshipServices>;

  beforeEach(() => {
    ctx = createTestRelationshipServices();
  });

  it("P2P end-to-end: invite -> accept -> financial setup -> agreement -> signatures -> activation", async () => {
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
    expect(relationship.status).toBe("invited");

    const afterAccept = await ctx.relationshipInvitationService.acceptInvitation({
      invitationId: invitation.id,
      actingUserId: debtorUserId,
      actingParty: { kind: "personal", id: debtorProfileId },
    });
    expect(afterAccept.status).toBe("financial_setup_pending");

    const funding = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: debtorUserId,
      actingParty: { kind: "personal", id: debtorProfileId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "debtor_bank_ref",
      maskedLast4: "1111",
      institutionDisplayName: "Debtor Bank",
    });
    await ctx.relationshipFinancialAccountService.applyVerificationResult(funding.id, "verified");
    await ctx.relationshipFinancialAccountService.assignAccount({
      relationshipId: relationship.id,
      actingUserId: debtorUserId,
      financialAccountId: funding.id,
      usage: "funding",
    });

    const payout = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: creditorUserId,
      actingParty: { kind: "personal", id: creditorProfileId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "creditor_bank_ref",
      maskedLast4: "2222",
      institutionDisplayName: "Creditor Bank",
    });
    await ctx.relationshipFinancialAccountService.applyVerificationResult(payout.id, "verified");
    const afterAccounts = await ctx.relationshipFinancialAccountService.assignAccount({
      relationshipId: relationship.id,
      actingUserId: creditorUserId,
      financialAccountId: payout.id,
      usage: "payout",
    });
    expect((await ctx.relationships.findById(relationship.id))?.status).toBe("financial_accounts_ready");
    void afterAccounts;

    const created = await ctx.agreementService.createDraft({
      creatorUserId: creditorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    await ctx.relationshipService.linkAgreement(relationship.id, created.agreement.id, creditorUserId);
    expect(await ctx.mandates.isActiveForAgreement(created.agreement.id)).toBe(true);

    await ctx.agreementService.submitDraft(created.agreement.id, creditorUserId);
    await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
    await ctx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });
    await ctx.agreementService.signAgreement(created.agreement.id, creditorUserId);
    await ctx.agreementService.signAgreement(created.agreement.id, debtorUserId);
    await ctx.relationshipService.syncFromAgreement(relationship.id, creditorUserId);

    const check = await ctx.relationshipService.checkActivationPrerequisites(relationship.id);
    expect(check.eligible).toBe(true);

    const activated = await ctx.relationshipService.activate(relationship.id, creditorUserId);
    expect(activated.status).toBe("active");

    const adminView = await ctx.relationshipService.getRelationshipForAdmin(relationship.id, randomUUID(), "platform_owner");
    expect(adminView.relationship.status).toBe("active");
    expect(adminView.participants).toHaveLength(2);
  });

  it("B2B: two organizations, each acting through an authorized staff member, use organization-owned financial accounts (never a staff member's personal account)", async () => {
    const creditorOwnerId = randomUUID();
    const creditorBusinessId = randomUUID();
    const creditorStaffId = randomUUID();
    const debtorOwnerId = randomUUID();
    const debtorBusinessId = randomUUID();
    const debtorStaffId = randomUUID();
    ctx.profileOwners.set("business", creditorBusinessId, creditorOwnerId);
    ctx.profileOwners.set("business", debtorBusinessId, debtorOwnerId);
    await ctx.staffCtx.staffMembers.insert({
      businessProfileId: creditorBusinessId,
      userId: creditorStaffId,
      role: "manager",
      customRoleId: null,
      isAuthorizedRepresentative: true,
    });
    const debtorTreasuryRole = await ctx.staffCtx.customRoles.insert({
      businessProfileId: debtorBusinessId,
      name: "Treasury",
      permissions: ["send_invitation", "change_payout_configuration"],
    });
    await ctx.staffCtx.staffMembers.insert({
      businessProfileId: debtorBusinessId,
      userId: debtorStaffId,
      role: "custom",
      customRoleId: debtorTreasuryRole.id,
      isAuthorizedRepresentative: true,
    });

    const { relationship, invitation, rawToken } = await ctx.relationshipInvitationService.createInvitation({
      actingUserId: creditorStaffId,
      actingParty: { kind: "business", id: creditorBusinessId },
      inviteeEmail: "debtor-business@example.com",
      inviteeRole: "debtor",
    });
    await ctx.relationshipInvitationService.acceptInvitation({
      invitationId: invitation.id,
      actingUserId: debtorStaffId,
      actingParty: { kind: "business", id: debtorBusinessId },
      rawToken,
    });

    // The debtor's staff member adds and assigns the *organization's* funding account.
    const fundingAccount = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: debtorStaffId,
      actingParty: { kind: "business", id: debtorBusinessId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "debtor_org_bank_ref",
      maskedLast4: "3333",
      institutionDisplayName: "Debtor Org Bank",
    });
    expect(fundingAccount.organizationId).toBe(debtorBusinessId);
    expect(fundingAccount.individualProfileId).toBeNull();
    await ctx.relationshipFinancialAccountService.applyVerificationResult(fundingAccount.id, "verified");
    await ctx.relationshipFinancialAccountService.assignAccount({
      relationshipId: relationship.id,
      actingUserId: debtorStaffId,
      financialAccountId: fundingAccount.id,
      usage: "funding",
    });

    // A staff member of the OTHER organization may not assign an account into a slot that isn't theirs.
    await expect(
      ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: relationship.id,
        actingUserId: creditorStaffId,
        financialAccountId: fundingAccount.id,
        usage: "payout",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("isolation: an unrelated third party cannot view or act on a relationship they do not participate in, and two parties may hold multiple concurrent relationships without cross-contamination", async () => {
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

    // Alice also has a SEPARATE concurrent relationship with Carol.
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

    expect(invite1.relationship.id).not.toBe(invite2.relationship.id);

    // Bob cannot see or act on Alice/Carol's relationship.
    await expect(ctx.relationshipService.getRelationship(invite2.relationship.id, bobUserId)).rejects.toThrow(ForbiddenError);
    await expect(ctx.relationshipService.close(invite2.relationship.id, bobUserId)).rejects.toThrow(ForbiddenError);

    // Alice's own relationship list contains exactly her two relationships, not more.
    const aliceRelationships = await ctx.relationshipService.listRelationshipsForParty(aliceUserId, { kind: "personal", id: aliceProfileId });
    expect(aliceRelationships.map((r) => r.id).sort()).toEqual([invite1.relationship.id, invite2.relationship.id].sort());

    // Bob's own relationship list contains only his relationship with Alice, not Alice/Carol's.
    const bobRelationships = await ctx.relationshipService.listRelationshipsForParty(bobUserId, { kind: "personal", id: bobProfileId });
    expect(bobRelationships.map((r) => r.id)).toEqual([invite1.relationship.id]);

    // A financial account belonging to one relationship's participant cannot be assigned into the other relationship by an unrelated party.
    const bobAccount = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: bobUserId,
      actingParty: { kind: "personal", id: bobProfileId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "bob_bank_ref",
      maskedLast4: "4444",
      institutionDisplayName: "Bob Bank",
    });
    await ctx.relationshipFinancialAccountService.applyVerificationResult(bobAccount.id, "verified");
    await expect(
      ctx.relationshipFinancialAccountService.assignAccount({
        relationshipId: invite2.relationship.id,
        actingUserId: bobUserId,
        financialAccountId: bobAccount.id,
        usage: "funding",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("B2C (Phase 52): an authorized business employee creates a relationship with an individual customer, who funds from her own personal account while the business receives into its organization account", async () => {
    const businessOwnerId = randomUUID();
    const businessId = randomUUID();
    const staffUserId = randomUUID();
    const viewerUserId = randomUUID();
    const janeUserId = randomUUID();
    const janeProfileId = randomUUID();
    ctx.profileOwners.set("business", businessId, businessOwnerId);
    ctx.profileOwners.set("personal", janeProfileId, janeUserId);
    ctx.users.set("jane@example.com", janeUserId);
    // A custom "Treasury" role, not the plain default "manager" role (which lacks change_payout_configuration by
    // default, per Sprint 4's own capability list) — this employee is explicitly authorized for both invitation
    // and financial-account actions, not merely a manager by title.
    const treasuryRole = await ctx.staffCtx.customRoles.insert({
      businessProfileId: businessId,
      name: "Treasury",
      permissions: ["send_invitation", "change_payout_configuration", "create_agreement"],
    });
    await ctx.staffCtx.staffMembers.insert({
      businessProfileId: businessId,
      userId: staffUserId,
      role: "custom",
      customRoleId: treasuryRole.id,
      isAuthorizedRepresentative: true,
    });
    // A viewer-only staff member (accountant_viewer: view_reports/export_records only) exists but must never be able to perform this binding action.
    await ctx.staffCtx.staffMembers.insert({
      businessProfileId: businessId,
      userId: viewerUserId,
      role: "accountant_viewer",
      customRoleId: null,
      isAuthorizedRepresentative: false,
    });
    await expect(
      ctx.relationshipInvitationService.createInvitation({
        actingUserId: viewerUserId,
        actingParty: { kind: "business", id: businessId },
        inviteeEmail: "jane@example.com",
        inviteeRole: "debtor",
      }),
    ).rejects.toThrow(ForbiddenError);

    const { relationship, invitation } = await ctx.relationshipInvitationService.createInvitation({
      actingUserId: staffUserId,
      actingParty: { kind: "business", id: businessId },
      inviteeEmail: "jane@example.com",
      inviteeRole: "debtor",
    });
    const afterAccept = await ctx.relationshipInvitationService.acceptInvitation({
      invitationId: invitation.id,
      actingUserId: janeUserId,
      actingParty: { kind: "personal", id: janeProfileId },
    });
    expect(afterAccept.status).toBe("financial_setup_pending"); // Jane's own explicit acceptance, never auto-accepted by signup

    const janeFunding = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: janeUserId,
      actingParty: { kind: "personal", id: janeProfileId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "jane_personal_bank_ref",
      maskedLast4: "5555",
      institutionDisplayName: "Jane's Bank",
    });
    await ctx.relationshipFinancialAccountService.applyVerificationResult(janeFunding.id, "verified");
    await ctx.relationshipFinancialAccountService.assignAccount({
      relationshipId: relationship.id,
      actingUserId: janeUserId,
      financialAccountId: janeFunding.id,
      usage: "funding",
    });

    const orgPayout = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: staffUserId,
      actingParty: { kind: "business", id: businessId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "abc_org_payout_ref",
      maskedLast4: "6666",
      institutionDisplayName: "ABC Org Bank",
    });
    expect(orgPayout.organizationId).toBe(businessId);
    expect(orgPayout.individualProfileId).toBeNull();
    await ctx.relationshipFinancialAccountService.applyVerificationResult(orgPayout.id, "verified");
    await ctx.relationshipFinancialAccountService.assignAccount({
      relationshipId: relationship.id,
      actingUserId: staffUserId,
      financialAccountId: orgPayout.id,
      usage: "payout",
    });
    expect((await ctx.relationships.findById(relationship.id))?.status).toBe("financial_accounts_ready");

    // Staff member's own personal account can never substitute for the organization's payout account.
    const staffPersonalProfileId = randomUUID();
    ctx.profileOwners.set("personal", staffPersonalProfileId, staffUserId);
    const staffPersonalAccount = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: staffUserId,
      actingParty: { kind: "personal", id: staffPersonalProfileId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "staff_personal_ref",
      maskedLast4: "7777",
      institutionDisplayName: "Staff Personal Bank",
    });
    await ctx.relationshipFinancialAccountService.applyVerificationResult(staffPersonalAccount.id, "verified");
    await expect(
      ctx.relationshipFinancialAccountService.replaceAccount({
        relationshipId: relationship.id,
        actingUserId: staffUserId,
        financialAccountId: staffPersonalAccount.id,
        usage: "payout",
      }),
    ).rejects.toThrow(ForbiddenError);

    const created = await ctx.agreementService.createDraft({
      creatorUserId: staffUserId,
      creditor: { kind: "business", id: businessId },
      debtor: { kind: "personal", id: janeProfileId },
      ...baseTerms(),
    });
    expect(ctx.agreementService.relationshipShape(created.agreement)).toBe("B2C");
    await ctx.relationshipService.linkAgreement(relationship.id, created.agreement.id, staffUserId);
    // The ledger/payment layer resolves organizational context purely through agreement.relationship_id — no separate relationship-side write needed here.
    expect((await ctx.relationships.findById(relationship.id))?.currentAgreementId).toBe(created.agreement.id);
  });

  it("activation is blocked specifically for a missing ACH mandate when a verified bank-account funding source has no active mandate yet (edge case around the auto-connector)", async () => {
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

    const funding = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: debtorUserId,
      actingParty: { kind: "personal", id: debtorProfileId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "debtor_bank_ref",
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
    const payout = await ctx.relationshipFinancialAccountService.addAccount({
      actingUserId: creditorUserId,
      actingParty: { kind: "personal", id: creditorProfileId },
      accountType: "bank_account",
      providerName: "sandbox",
      providerAccountRef: "creditor_bank_ref",
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

    const created = await ctx.agreementService.createDraft({
      creatorUserId: creditorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    await ctx.relationshipService.linkAgreement(relationship.id, created.agreement.id, creditorUserId);
    // Simulate the mandate having been revoked out-of-band after linkAgreement's own auto-authorization (e.g. a Sprint 11 AchMandateService.revoke call) without this test needing that service directly.
    ctx.mandates.activeByAgreement.delete(created.agreement.id);

    await ctx.agreementService.submitDraft(created.agreement.id, creditorUserId);
    await ctx.agreementService.acknowledgeDebt(created.agreement.id, debtorUserId);
    await ctx.agreementService.creditorDecide({ agreementId: created.agreement.id, actingUserId: creditorUserId, decision: "accept" });
    await ctx.agreementService.signAgreement(created.agreement.id, creditorUserId);
    await ctx.agreementService.signAgreement(created.agreement.id, debtorUserId);

    const check = await ctx.relationshipService.checkActivationPrerequisites(relationship.id);
    expect(check.eligible).toBe(false);
    expect(check.reasons).toContain("mandate_missing");
    await expect(ctx.relationshipService.activate(relationship.id, creditorUserId)).rejects.toThrow(ValidationError);
  });

  it("the same user can hold different roles across different concurrent relationships (creditor in one, debtor in another)", async () => {
    const aliceUserId = randomUUID();
    const aliceLenderProfileId = randomUUID();
    const aliceBorrowerProfileId = randomUUID();
    const bobUserId = randomUUID();
    const bobProfileId = randomUUID();
    ctx.profileOwners.set("personal", aliceLenderProfileId, aliceUserId);
    ctx.profileOwners.set("personal", aliceBorrowerProfileId, aliceUserId);
    ctx.profileOwners.set("personal", bobProfileId, bobUserId);
    ctx.users.set("alice-borrower@example.com", aliceUserId);
    ctx.users.set("bob@example.com", bobUserId);

    // Alice lends to Bob (Alice = creditor).
    const lendInvite = await ctx.relationshipInvitationService.createInvitation({
      actingUserId: aliceUserId,
      actingParty: { kind: "personal", id: aliceLenderProfileId },
      inviteeEmail: "bob@example.com",
      inviteeRole: "debtor",
    });
    const lendRelationship = await ctx.relationshipInvitationService.acceptInvitation({
      invitationId: lendInvite.invitation.id,
      actingUserId: bobUserId,
      actingParty: { kind: "personal", id: bobProfileId },
    });

    // Bob separately lends to Alice, using her OTHER personal profile (Alice = debtor this time).
    const borrowInvite = await ctx.relationshipInvitationService.createInvitation({
      actingUserId: bobUserId,
      actingParty: { kind: "personal", id: bobProfileId },
      inviteeEmail: "alice-borrower@example.com",
      inviteeRole: "debtor",
    });
    const borrowRelationship = await ctx.relationshipInvitationService.acceptInvitation({
      invitationId: borrowInvite.invitation.id,
      actingUserId: aliceUserId,
      actingParty: { kind: "personal", id: aliceBorrowerProfileId },
    });

    const lendParticipants = await ctx.participants.listForRelationship(lendRelationship.id);
    const borrowParticipants = await ctx.participants.listForRelationship(borrowRelationship.id);
    expect(lendParticipants.find((p) => p.representedByUserId === aliceUserId)?.role).toBe("creditor");
    expect(borrowParticipants.find((p) => p.representedByUserId === aliceUserId)?.role).toBe("debtor");
  });
});
