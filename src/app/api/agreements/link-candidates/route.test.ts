import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestRelationshipServices } from "@/lib/relationships/testFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createAgreementLinkCandidatesHandler } from "./route";

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
    hardshipRules: "Borrower may request hardship relief.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

/**
 * Missing-connection remediation (mandatory command): proves the "Choose Existing Connection"
 * candidate list only ever includes a connection with the agreement's actual counterparty, never any
 * of the acting user's other connections, and never one already governing an agreement.
 */
describe("GET /api/agreements/link-candidates", () => {
  let relCtx: ReturnType<typeof createTestRelationshipServices>;
  let authCtx: ReturnType<typeof createTestAuthService>;

  beforeEach(() => {
    relCtx = createTestRelationshipServices();
    authCtx = createTestAuthService();
  });

  function handler() {
    return withErrorHandling("agreement_link_candidates", createAgreementLinkCandidatesHandler(authCtx.authService, relCtx.relationshipService));
  }

  function get(agreementId: string, token?: string) {
    return new NextRequest(`http://localhost/api/agreements/link-candidates?agreementId=${agreementId}`, {
      method: "GET",
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  async function signupWithProfile(label: string) {
    const user = await authCtx.authService.signup({
      email: `${label}-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const profileId = randomUUID();
    relCtx.profileOwners.set("personal", profileId, user.user.id);
    return { user, profileId };
  }

  async function connect(creditor: { user: { user: { id: string; email: string } } }, creditorProfileId: string, debtorProfileId: string, debtorUserId: string, debtorEmail: string) {
    relCtx.users.set(debtorEmail, debtorUserId);
    const { relationship, invitation } = await relCtx.relationshipInvitationService.createInvitation({
      actingUserId: creditor.user.user.id,
      actingParty: { kind: "personal", id: creditorProfileId },
      inviteeEmail: debtorEmail,
      inviteeRole: "debtor",
    });
    await relCtx.relationshipInvitationService.acceptInvitation({
      invitationId: invitation.id,
      actingUserId: debtorUserId,
      actingParty: { kind: "personal", id: debtorProfileId },
    });
    return relationship;
  }

  it("includes only the connection matching the agreement's actual counterparty, excluding an unrelated one", async () => {
    const creditor = await signupWithProfile("creditor");
    const debtor = await signupWithProfile("debtor");
    const stranger = await signupWithProfile("stranger");

    const matchingRelationship = await connect(creditor, creditor.profileId, debtor.profileId, debtor.user.user.id, debtor.user.user.email);
    await connect(creditor, creditor.profileId, stranger.profileId, stranger.user.user.id, stranger.user.user.email);

    // The agreement is created WITHOUT linking a relationship (mirrors the agreement-invitation
    // flow's exact real-world gap this whole mandate is about).
    const created = await relCtx.agreementService.createDraft({
      creatorUserId: creditor.user.user.id,
      creditor: { kind: "personal", id: creditor.profileId },
      debtor: { kind: "personal", id: debtor.profileId },
      ...baseTerms(),
    });

    const response = await handler()(get(created.agreement.id, creditor.user.token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { relationships: Array<{ id: string }> };
    expect(body.relationships.map((r) => r.id)).toEqual([matchingRelationship.id]);
  });

  /**
   * Decision 2 (canonical connection): "Connection identity = the two parties" — a connection already
   * governing another (same-role, non-terminal) agreement remains a valid "Choose Existing Connection"
   * candidate for a second agreement between the same two parties; `current_agreement_id` is no longer
   * an exclusivity gate. Replaces the old "excludes a matching connection that already governs a
   * different agreement" expectation, which asserted the pre-Decision-2 one-agreement-per-connection
   * restriction.
   */
  it("includes a matching connection that already governs a different (non-terminal, same-role) agreement", async () => {
    const creditor = await signupWithProfile("creditor");
    const debtor = await signupWithProfile("debtor");
    const relationship = await connect(creditor, creditor.profileId, debtor.profileId, debtor.user.user.id, debtor.user.user.email);

    const alreadyLinked = await relCtx.agreementService.createDraft({
      creatorUserId: creditor.user.user.id,
      creditor: { kind: "personal", id: creditor.profileId },
      debtor: { kind: "personal", id: debtor.profileId },
      ...baseTerms(),
    });
    await relCtx.relationshipService.linkAgreement(relationship.id, alreadyLinked.agreement.id, creditor.user.user.id);

    const secondAgreement = await relCtx.agreementService.createDraft({
      creatorUserId: creditor.user.user.id,
      creditor: { kind: "personal", id: creditor.profileId },
      debtor: { kind: "personal", id: debtor.profileId },
      ...baseTerms(),
    });

    const response = await handler()(get(secondAgreement.agreement.id, creditor.user.token));
    const body = (await response.json()) as { relationships: Array<{ id: string }> };
    expect(body.relationships.map((r) => r.id)).toEqual([relationship.id]);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const creditor = await signupWithProfile("creditor");
    const debtor = await signupWithProfile("debtor");
    const created = await relCtx.agreementService.createDraft({
      creatorUserId: creditor.user.user.id,
      creditor: { kind: "personal", id: creditor.profileId },
      debtor: { kind: "personal", id: debtor.profileId },
      ...baseTerms(),
    });
    const response = await handler()(get(created.agreement.id));
    expect(response.status).toBe(401);
  });
});
