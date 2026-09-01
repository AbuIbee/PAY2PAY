import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import type { AgreementConnectionEstablisher, DraftTermsInput } from "@/lib/agreements/agreementService";
import { createTestAgreementRelationshipEstablisher } from "./testFakes";

function baseTerms(overrides: Partial<DraftTermsInput> = {}): DraftTermsInput {
  return {
    category: "personal_loan",
    description: "Loan for car repair",
    originalAmountMinorUnits: 120_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 20_000,
    installmentAmountMinorUnits: 20_000,
    frequency: "monthly",
    firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    feeAllocation: "debtor_pays",
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Borrower may request hardship relief; no interest or penalty added.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

/**
 * Production defect remediation (canonical connection) — Step-1/Step-2 lifecycle correction: proves
 * the authoritative lifecycle end to end at the real RelationshipService/AgreementService boundary (a
 * real connectionEstablisher, backed by a real RelationshipService, via the shared
 * createTestAgreementRelationshipEstablisher box-wiring precedent) — not stubbed. Step 1
 * (AgreementService.createDraft) must establish/reuse the canonical relationship WITHOUT falsely
 * representing an unconfirmed counterparty as a fully active connection; Step 2
 * (AgreementService.creditorDecide's accept branch) must confirm the SAME relationship, never create a
 * second one.
 */
describe("Step 1 / Step 2 canonical relationship lifecycle (production defect remediation)", () => {
  let ctx: ReturnType<typeof createTestAgreementService>;
  let relationshipCtx: ReturnType<typeof createTestAgreementRelationshipEstablisher>;

  beforeEach(() => {
    const connectionEstablisherBox: { target: AgreementConnectionEstablisher | null } = { target: null };
    const connectionEstablisher: AgreementConnectionEstablisher = {
      establishAgreementRelationship: (input) => {
        if (!connectionEstablisherBox.target) throw new Error("test connectionEstablisher not wired yet");
        return connectionEstablisherBox.target.establishAgreementRelationship(input);
      },
      proposeAgreementRelationship: (input) => {
        if (!connectionEstablisherBox.target) throw new Error("test connectionEstablisher not wired yet");
        return connectionEstablisherBox.target.proposeAgreementRelationship(input);
      },
      confirmAgreementRelationship: (input) => {
        if (!connectionEstablisherBox.target) throw new Error("test connectionEstablisher not wired yet");
        return connectionEstablisherBox.target.confirmAgreementRelationship(input);
      },
    };
    ctx = createTestAgreementService(undefined, undefined, connectionEstablisher);
    relationshipCtx = createTestAgreementRelationshipEstablisher(ctx);
    connectionEstablisherBox.target = relationshipCtx.relationshipService;
  });

  function registerParty() {
    const userId = randomUUID();
    const profileId = randomUUID();
    ctx.profileOwners.set("personal", profileId, userId);
    return { userId, profileId };
  }

  async function createDraft(creditor: ReturnType<typeof registerParty>, debtor: ReturnType<typeof registerParty>, creatorUserId: string) {
    return ctx.agreementService.createDraft({
      creatorUserId,
      creditor: { kind: "personal", id: creditor.profileId },
      debtor: { kind: "personal", id: debtor.profileId },
      ...baseTerms(),
    });
  }

  async function acceptToSignatures(agreementId: string, creditorUserId: string, debtorUserId: string) {
    await ctx.agreementService.submitDraft(agreementId, creditorUserId);
    await ctx.agreementService.acknowledgeDebt(agreementId, debtorUserId);
    await ctx.agreementService.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });
  }

  it("test 1 — an existing, already-confirmed A/B relationship is reused at Step 1", async () => {
    const creditor = registerParty();
    const debtor = registerParty();
    const first = await createDraft(creditor, debtor, debtor.userId);
    await acceptToSignatures(first.agreement.id, creditor.userId, debtor.userId);
    const r1 = first.agreement.relationshipId!;
    expect(r1).toBeTruthy();
    const confirmed = (await relationshipCtx.relationships.findById(r1))!;
    expect(confirmed.status).not.toBe("invited");

    const second = await createDraft(creditor, debtor, debtor.userId);
    expect(second.agreement.relationshipId).toBe(r1);
    expect(relationshipCtx.relationships.byId.size).toBe(1);
  });

  it("test 2/4 — no existing relationship: Step 1 creates ONE canonical A/B relationship, and agreement.relationship_id is populated with it immediately", async () => {
    const creditor = registerParty();
    const debtor = registerParty();
    const draft = await createDraft(creditor, debtor, debtor.userId);

    expect(draft.agreement.relationshipId).toBeTruthy();
    expect(relationshipCtx.relationships.byId.size).toBe(1);
    const participants = await relationshipCtx.participants.listForRelationship(draft.agreement.relationshipId!);
    expect(participants).toHaveLength(2);
  });

  it("test 3 — the new Step-1 relationship is NOT falsely represented as fully confirmed/active before the counterparty accepts", async () => {
    const creditor = registerParty();
    const debtor = registerParty();
    // The debtor originates and is therefore the "initiator" whose own side is immediately active;
    // the creditor (counterparty) has not yet done anything.
    const draft = await createDraft(creditor, debtor, debtor.userId);

    const relationship = (await relationshipCtx.relationships.findById(draft.agreement.relationshipId!))!;
    expect(relationship.status).toBe("invited");

    const participants = await relationshipCtx.participants.listForRelationship(draft.agreement.relationshipId!);
    const initiatorParticipant = participants.find((p) => p.individualProfileId === debtor.profileId);
    const counterpartyParticipant = participants.find((p) => p.individualProfileId === creditor.profileId);
    expect(initiatorParticipant?.status).toBe("active");
    expect(counterpartyParticipant?.status).toBe("invited");
    expect(counterpartyParticipant?.joinedAt).toBeNull();
  });

  it("test 5/6 — Step 2 acceptance confirms/activates the SAME relationship ID and creates ZERO additional relationships", async () => {
    const creditor = registerParty();
    const debtor = registerParty();
    const draft = await createDraft(creditor, debtor, debtor.userId);
    const r1 = draft.agreement.relationshipId!;

    await acceptToSignatures(draft.agreement.id, creditor.userId, debtor.userId);

    const agreement = await ctx.agreements.byId.get(draft.agreement.id);
    expect(agreement!.relationshipId).toBe(r1);
    expect(relationshipCtx.relationships.byId.size).toBe(1);

    const participants = await relationshipCtx.participants.listForRelationship(r1);
    expect(participants.every((p) => p.status === "active")).toBe(true);
    const relationship = (await relationshipCtx.relationships.findById(r1))!;
    expect(relationship.status).not.toBe("invited");
  });

  it("test 7 — Step 2 decline does NOT leave the newly-created relationship falsely confirmed/active", async () => {
    const creditor = registerParty();
    const debtor = registerParty();
    const draft = await createDraft(creditor, debtor, debtor.userId);
    const r1 = draft.agreement.relationshipId!;

    await ctx.agreementService.submitDraft(draft.agreement.id, creditor.userId);
    await ctx.agreementService.acknowledgeDebt(draft.agreement.id, debtor.userId);
    await ctx.agreementService.creditorDecide({ agreementId: draft.agreement.id, actingUserId: creditor.userId, decision: "reject", reason: "Not agreed." });

    const relationship = (await relationshipCtx.relationships.findById(r1))!;
    expect(relationship.status).toBe("invited");
    const participants = await relationshipCtx.participants.listForRelationship(r1);
    const counterpartyParticipant = participants.find((p) => p.individualProfileId === creditor.profileId);
    expect(counterpartyParticipant?.status).toBe("invited");
  });

  it("test 8 — an abandoned/pre-acceptance draft does not create the appearance of a mutually confirmed connection", async () => {
    const creditor = registerParty();
    const debtor = registerParty();
    const draft = await createDraft(creditor, debtor, debtor.userId);

    // Never advanced past draft — abandoned.
    const relationship = (await relationshipCtx.relationships.findById(draft.agreement.relationshipId!))!;
    expect(relationship.status).toBe("invited");
    const participants = await relationshipCtx.participants.listForRelationship(draft.agreement.relationshipId!);
    expect(participants.some((p) => p.status === "invited")).toBe(true);
    expect(participants.every((p) => p.status === "active")).toBe(false);
  });

  it("test 9 — retry of Step 1 (a second draft for the same still-pending pair) is idempotent: reuses R1, never creates R2", async () => {
    const creditor = registerParty();
    const debtor = registerParty();
    const first = await createDraft(creditor, debtor, debtor.userId);
    const r1 = first.agreement.relationshipId!;

    // Abandoned — never accepted. A second draft between the exact same still-pending pair.
    const second = await createDraft(creditor, debtor, debtor.userId);

    expect(second.agreement.relationshipId).toBe(r1);
    expect(relationshipCtx.relationships.byId.size).toBe(1);
  });

  it("test 10 — retry of Step 2 (repeated confirm) is idempotent", async () => {
    const creditor = registerParty();
    const debtor = registerParty();
    const draft = await createDraft(creditor, debtor, debtor.userId);
    const r1 = draft.agreement.relationshipId!;
    await acceptToSignatures(draft.agreement.id, creditor.userId, debtor.userId);

    // A direct repeated call to the same confirm method a retry would use.
    const again = await relationshipCtx.relationshipService.confirmAgreementRelationship({
      agreementId: draft.agreement.id,
      creditor: { kind: "personal", id: creditor.profileId },
      creditorUserId: creditor.userId,
      debtor: { kind: "personal", id: debtor.profileId },
      debtorUserId: debtor.userId,
      initiatingUserId: creditor.userId,
    });
    expect(again.relationshipId).toBe(r1);
    expect(relationshipCtx.relationships.byId.size).toBe(1);
    const participants = await relationshipCtx.participants.listForRelationship(r1);
    expect(participants).toHaveLength(2);
  });

  it("test 11 — concurrent Step 1 processing for the same pair cannot create R1 + R2 duplicates", async () => {
    const creditor = registerParty();
    const debtor = registerParty();

    const [a, b] = await Promise.all([createDraft(creditor, debtor, debtor.userId), createDraft(creditor, debtor, debtor.userId)]);

    expect(a.agreement.relationshipId).toBeTruthy();
    expect(a.agreement.relationshipId).toBe(b.agreement.relationshipId);
    expect(relationshipCtx.relationships.byId.size).toBe(1);
  });

  it("test 12 — an existing ACTIVE relationship must not be downgraded to pending when reused for a new agreement", async () => {
    const creditor = registerParty();
    const debtor = registerParty();
    const first = await createDraft(creditor, debtor, debtor.userId);
    await acceptToSignatures(first.agreement.id, creditor.userId, debtor.userId);
    const r1 = first.agreement.relationshipId!;
    const beforeReuse = (await relationshipCtx.relationships.findById(r1))!;
    expect(beforeReuse.status).not.toBe("invited");

    const second = await createDraft(creditor, debtor, debtor.userId);
    expect(second.agreement.relationshipId).toBe(r1);

    const afterReuse = (await relationshipCtx.relationships.findById(r1))!;
    expect(afterReuse.status).toBe(beforeReuse.status);
    const participants = await relationshipCtx.participants.listForRelationship(r1);
    expect(participants.every((p) => p.status === "active")).toBe(true);
  });

  it("test 13 — User C cannot be linked: an unrelated third party's own relationship is never reused, and only A/B ever become participants", async () => {
    const creditor = registerParty();
    const debtor = registerParty();
    const strangerA = registerParty();
    const strangerB = registerParty();

    // An unrelated pair's own, completely independent relationship.
    const strangerDraft = await createDraft(strangerA, strangerB, strangerB.userId);
    await acceptToSignatures(strangerDraft.agreement.id, strangerA.userId, strangerB.userId);
    const strangerRelationshipId = strangerDraft.agreement.relationshipId!;

    const draft = await createDraft(creditor, debtor, debtor.userId);

    expect(draft.agreement.relationshipId).not.toBe(strangerRelationshipId);
    const participants = await relationshipCtx.participants.listForRelationship(draft.agreement.relationshipId!);
    expect(participants.map((p) => p.individualProfileId).sort()).toEqual([creditor.profileId, debtor.profileId].sort());
    expect(relationshipCtx.relationships.byId.size).toBe(2);
  });
});
