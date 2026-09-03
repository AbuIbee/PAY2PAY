import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_SIGNUP_IDENTITY, TEST_ADULT_DATE_OF_BIRTH, createTestAuthService } from "@/lib/auth/testFakes";
import { createTestAgreementService } from "@/lib/agreements/testFakes";
import { createTestAgreementRelationshipEstablisher } from "@/lib/relationships/testFakes";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { createEnsureRelationshipHandler } from "./route";

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

function postWithCookie(agreementId: string | null, token?: string) {
  return new NextRequest("http://localhost/api/agreements/ensure-relationship", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `p2p_session=${token}` } : {}),
    },
    body: JSON.stringify(agreementId ? { agreementId } : {}),
  });
}

/**
 * Production defect remediation (canonical connection) — Correction 1: proves the ONE explicit,
 * idempotent, authenticated, agreement-authorized POST mutation the Agreement page invokes
 * automatically in place of the removed getProgress()-side mutation. Uses a REAL connectionEstablisher
 * (backed by a real RelationshipService, via the shared box-wiring precedent from
 * agreementInvitations/testFakes.ts) so establishment/reuse/idempotency are exercised end to end, not
 * stubbed.
 */
describe("POST /api/agreements/ensure-relationship", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let agreementCtx: ReturnType<typeof createTestAgreementService>;
  let relationshipCtx: ReturnType<typeof createTestAgreementRelationshipEstablisher>;
  let agreementId: string;
  let creditorUserId: string;
  let debtorUserId: string;
  let creditorToken: string;
  let debtorToken: string;
  let strangerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();

    const connectionEstablisherBox: { target: import("@/lib/agreements/agreementService").AgreementConnectionEstablisher | null } = { target: null };
    const connectionEstablisher: import("@/lib/agreements/agreementService").AgreementConnectionEstablisher = {
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
    agreementCtx = createTestAgreementService(undefined, undefined, connectionEstablisher);
    relationshipCtx = createTestAgreementRelationshipEstablisher(agreementCtx);
    connectionEstablisherBox.target = relationshipCtx.relationshipService;

    const creditor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `ensure-rel-creditor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const debtor = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `ensure-rel-debtor-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const stranger = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: `ensure-rel-stranger-${randomUUID()}@example.com`,
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    creditorToken = creditor.token;
    debtorToken = debtor.token;
    strangerToken = stranger.token;
    creditorUserId = creditor.user.id;
    debtorUserId = debtor.user.id;

    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);

    const created = await agreementCtx.agreementService.createDraft({
      creatorUserId: debtorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    agreementId = created.agreement.id;
    await agreementCtx.agreementService.submitDraft(agreementId, debtorUserId);
    await agreementCtx.agreementService.acknowledgeDebt(agreementId, debtorUserId);
    // Force the legacy/failed-repair shape this route exists to fix: acceptance completed, but
    // relationship_id is null (simulating a record that predates centralized auto-establishment, or
    // whose original accept-time attempt silently failed).
    await agreementCtx.agreementService.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });
    agreementCtx.agreements.byId.get(agreementId)!.relationshipId = null;
  });

  function handlerFor() {
    return withErrorHandling("agreement_ensure_relationship", createEnsureRelationshipHandler(authCtx.authService, agreementCtx.agreementService));
  }

  it("populates relationship_id for an authenticated, real party (200)", async () => {
    expect(agreementCtx.agreements.byId.get(agreementId)!.relationshipId).toBeNull();
    const response = await handlerFor()(postWithCookie(agreementId, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { relationshipId: string | null };
    expect(body.relationshipId).toBeTruthy();
    expect(agreementCtx.agreements.byId.get(agreementId)!.relationshipId).toBe(body.relationshipId);
  });

  it("either real party may invoke it (debtor too, not just creditor)", async () => {
    const response = await handlerFor()(postWithCookie(agreementId, debtorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { relationshipId: string | null };
    expect(body.relationshipId).toBeTruthy();
  });

  it("rejects an unauthenticated request with 401 — no mutation occurs", async () => {
    const response = await handlerFor()(postWithCookie(agreementId, undefined));
    expect(response.status).toBe(401);
    expect(agreementCtx.agreements.byId.get(agreementId)!.relationshipId).toBeNull();
  });

  it("rejects an unrelated user (User C) with 403 — no mutation occurs, and no relationship they don't belong to can ever be selected", async () => {
    const response = await handlerFor()(postWithCookie(agreementId, strangerToken));
    expect(response.status).toBe(403);
    expect(agreementCtx.agreements.byId.get(agreementId)!.relationshipId).toBeNull();
  });

  it("rejects a request missing agreementId (400)", async () => {
    const response = await handlerFor()(postWithCookie(null, creditorToken));
    expect(response.status).toBe(400);
  });

  it("is idempotent — repeated calls never create a second relationship", async () => {
    const first = await handlerFor()(postWithCookie(agreementId, creditorToken));
    const firstBody = (await first.json()) as { relationshipId: string | null };
    const second = await handlerFor()(postWithCookie(agreementId, creditorToken));
    const secondBody = (await second.json()) as { relationshipId: string | null };
    expect(secondBody.relationshipId).toBe(firstBody.relationshipId);
  });

  it("Correction 3 — a fresh draft already has relationship_id populated at Step 1, before Step 2 has run", async () => {
    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);
    const draft = await agreementCtx.agreementService.createDraft({
      creatorUserId: debtorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    expect(agreementCtx.agreements.byId.get(draft.agreement.id)!.relationshipId).toBeTruthy();
  });

  it("this route never establishes a connection for a still-pre-acceptance (draft) agreement, even if relationship_id is null on it", async () => {
    const creditorProfileId = randomUUID();
    const debtorProfileId = randomUUID();
    agreementCtx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    agreementCtx.profileOwners.set("personal", debtorProfileId, debtorUserId);
    const draft = await agreementCtx.agreementService.createDraft({
      creatorUserId: debtorUserId,
      creditor: { kind: "personal", id: creditorProfileId },
      debtor: { kind: "personal", id: debtorProfileId },
      ...baseTerms(),
    });
    // Simulate Step 1's own establishment attempt having failed for this draft.
    agreementCtx.agreements.byId.get(draft.agreement.id)!.relationshipId = null;

    const response = await handlerFor()(postWithCookie(draft.agreement.id, creditorToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { relationshipId: string | null };
    expect(body.relationshipId).toBeNull();
    expect(agreementCtx.agreements.byId.get(draft.agreement.id)!.relationshipId).toBeNull();
  });
});
